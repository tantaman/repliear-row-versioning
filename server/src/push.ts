import {z} from 'zod';
import {Executor, transact} from './pg';
import {
  createComment,
  deleteComment,
  getClientForUpdate,
  getClientGroupForUpdate,
  putClient,
  putClientGroup,
  putDescription,
  putIssue,
  updateDescription,
  updateIssue,
  // putIssue,
  // deleteIssue,
  // putDescription,
  // createComment,
  // deleteComment,
} from './data';
import type {ReadonlyJSONValue} from 'replicache';
import {getPokeBackend} from './poke';
import {
  mutationNames,
  issueWithDescriptionSchema,
  issueUpdateWithIDSchema,
  commentSchema,
} from 'shared';

const mutationSchema = z.object({
  id: z.number(),
  clientID: z.string(),
  name: z.enum(mutationNames),
  args: z.any(),
});

type Mutation = z.infer<typeof mutationSchema>;

const pushRequestSchema = z.object({
  clientGroupID: z.string(),
  mutations: z.array(mutationSchema),
});

export async function push(requestBody: ReadonlyJSONValue) {
  console.log('Processing push', JSON.stringify(requestBody, null, ''));

  const push = pushRequestSchema.parse(requestBody);

  const t0 = Date.now();

  for (const mutation of push.mutations) {
    const result = await processMutation(push.clientGroupID, mutation, null);
    if (result && 'error' in result) {
      // TODO: we could gather affected ids for fine grained refresh of the impacted items.
      await processMutation(push.clientGroupID, mutation, result.error);
    }
  }

  getPokeBackend().poke('poke'); // ouch

  console.log('Processed all mutations in', Date.now() - t0);
}

async function processMutation(
  clientGroupID: string,
  mutation: Mutation,
  error: string | null,
): Promise<null | {error: string}> {
  return await transact(async executor => {
    console.log(
      error === null ? 'Processing mutation' : 'Processing mutation error',
      JSON.stringify(mutation, null, ''),
    );

    // Get a write lock on the client group first to serialize with other
    // requests from the CG and avoid deadlocks.
    const baseClientGroup = await getClientGroupForUpdate(
      executor,
      clientGroupID,
    );
    const baseClient = await getClientForUpdate(executor, mutation.clientID);

    console.log({baseClientGroup, baseClient});

    const nextClientVersion = baseClientGroup.clientVersion + 1;
    const nextMutationID = baseClient.lastMutationID + 1;

    if (mutation.id < nextMutationID) {
      console.log(
        `Mutation ${mutation.id} has already been processed - skipping`,
      );
      return null;
    }
    if (mutation.id > nextMutationID) {
      throw new Error(`Mutation ${mutation.id} is from the future - aborting`);
    }

    const t1 = Date.now();

    if (error === null) {
      try {
        await mutate(executor, mutation);
      } catch (e) {
        console.error(
          `Error executing mutation: ${JSON.stringify(mutation)}: ${e}`,
        );
        return {error: String(e)};
      }
    }

    const nextClientGroup = {
      id: clientGroupID,
      cvrVersion: baseClientGroup.cvrVersion,
      clientVersion: nextClientVersion,
    };

    const nextClient = {
      id: mutation.clientID,
      clientGroupID,
      lastMutationID: nextMutationID,
      clientVersion: nextClientVersion,
    };

    await Promise.all([
      putClientGroup(executor, nextClientGroup),
      putClient(executor, nextClient),
    ]);

    console.log('Processed mutation in', Date.now() - t1);
    return null;
  });
}

async function mutate(executor: Executor, mutation: Mutation): Promise<void> {
  const {name} = mutation;
  console.log(name);
  console.log(mutation);
  switch (name) {
    case 'putIssue': {
      const {issue, description} = issueWithDescriptionSchema.parse(
        mutation.args,
      );
      await putIssue(executor, issue);
      await putDescription(executor, description);
      break;
    }
    case 'updateIssues': {
      const updates = z.array(issueUpdateWithIDSchema).parse(mutation.args);
      updates.map(async update => {
        // issue needs to exist first so the description can reference it
        await updateIssue(executor, update.id, update.issueChanges);
        if (update.descriptionChange === undefined) return;
        await updateDescription(executor, update.id, update.descriptionChange);
      });
      break;
    }
    case 'putIssueComment': {
      await createComment(executor, commentSchema.parse(mutation.args));
      break;
    }
    case 'deleteIssueComment': {
      await deleteComment(executor, commentSchema.parse(mutation.args).id);
      break;
    }
  }
}
