import {useCallback, useEffect} from 'react';
import type {
  ReadTransaction,
  Replicache,
  ExperimentalDiff as Diff,
} from 'replicache';
import type {M} from './model/mutators';
import {useState} from 'react';
import {minBy, pickBy} from 'lodash';
import {generateKeyBetween} from 'fractional-indexing';
import type {UndoManager} from '@rocicorp/undo';
import {HotKeys} from 'react-hotkeys';
import {
  useCreatedFilterState,
  useCreatorFilterState,
  useIssueDetailState,
  useModifiedFilterState,
  useOrderByState,
  usePriorityFilterState,
  useStatusFilterState,
  useViewState,
} from './hooks/query-state-hooks';
import {useSubscribe} from 'replicache-react';
import {getPartialSyncState} from './model/control';
import {
  Comment,
  Description,
  Issue,
  IssueUpdate,
  IssueUpdateWithID,
  ISSUE_KEY_PREFIX,
  Order,
  PartialSyncState,
} from 'shared';
import {
  getCreatedFilter,
  getCreatorFilter,
  getCreators,
  hasNonViewFilters as doesHaveNonViewFilters,
  getModifiedFilter,
  getPriorities,
  getPriorityFilter,
  getStatuses,
  getStatusFilter,
  getViewFilter,
  getViewStatuses,
} from './filters';
import {Layout} from './layout/layout';
import {useExclusiveEffect} from './util/useLock';
import {Materialite} from '@vlcn.io/materialite';
import {issueFromKeyAndValue} from './issue/issue';
import {getOrderValue, IssueViews} from './reducer';
import {IStatefulSource} from '@vlcn.io/materialite/dist/sources/Source';
import {MutableSetSource} from '@vlcn.io/materialite/dist/sources/MutableSetSource';
import {AbstractDifferenceStream} from '@vlcn.io/materialite/dist/core/graph/AbstractDifferenceStream';

type AppProps = {
  rep: Replicache<M>;
  undoManager: UndoManager;
};

const materialite = new Materialite();

function getOrderFn(order: Order) {
  return (l: Issue, r: Issue) => {
    const comp = getOrderValue(order, l).localeCompare(getOrderValue(order, r));
    if (comp === 0) {
      return l.id.localeCompare(r.id);
    }
    return comp;
  };
}

function filteredIssuesView(
  source: IStatefulSource<Issue, MutableSetSource<Issue>['value']>,
  comp: (l: Issue, r: Issue) => number,
  filters: (((i: Issue) => boolean) | null)[],
) {
  let {stream}: {stream: AbstractDifferenceStream<Issue>} = source;
  for (const f of filters) {
    if (!f) {
      continue;
    }
    stream = stream.filter(f);
  }
  return stream.materialize(comp);
}

function issueCountView(
  source: IStatefulSource<Issue, MutableSetSource<Issue>['value']>,
  filter: (i: Issue) => boolean,
) {
  return source.stream.filter(filter).size().materializeValue(0);
}

const App = ({rep, undoManager}: AppProps) => {
  const [view] = useViewState();
  const [priorityFilter] = usePriorityFilterState();
  const [statusFilter] = useStatusFilterState();
  const [createdFilter] = useCreatedFilterState();
  const [modifiedFilter] = useModifiedFilterState();
  const [creatorFilter] = useCreatorFilterState();
  const [orderBy] = useOrderByState();
  const [lastOrderBy, setLastOrderBy] = useState(orderBy);
  const [detailIssueID, setDetailIssueID] = useIssueDetailState();
  const [menuVisible, setMenuVisible] = useState(false);

  const [allIssueSet, setAllIssueSet] = useState(() =>
    materialite.newSortedSet<Issue>(getOrderFn(orderBy || 'MODIFIED')),
  );

  if (lastOrderBy !== orderBy) {
    setLastOrderBy(orderBy);
    // we need to derive a new set from the last set.
    // the change is just the ordering...
    // newSourceFrom(prevSource) or some such?
    setAllIssueSet(
      allIssueSet.withNewOrdering(getOrderFn(orderBy || 'MODIFIED')),
    );
  }

  const [issueViews, setIssueViews] = useState<IssueViews>({
    issueCount: 0,
    filteredIssues: allIssueSet.value,
    hasNonViewFilters: false,
  });

  useEffect(
    () => {
      const start = performance.now();
      const viewStatuses = getViewStatuses(view);
      const statuses = getStatuses(statusFilter);
      const statusFilterFn = getStatusFilter(viewStatuses, statuses);
      const viewFilterFn = getViewFilter(viewStatuses);
      const filterFns = [
        statusFilterFn,
        getPriorityFilter(getPriorities(priorityFilter)),
        getCreatorFilter(getCreators(creatorFilter)),
        getCreatedFilter(createdFilter),
        getModifiedFilter(modifiedFilter),
      ];

      const hasNonViewFilters = !!(
        doesHaveNonViewFilters(viewStatuses, statuses) ||
        filterFns.filter(f => f !== null && f !== statusFilterFn).length > 0
      );

      const filterView = filteredIssuesView(
        allIssueSet,
        allIssueSet.comparator,
        filterFns,
      );
      const countView = issueCountView(allIssueSet, viewFilterFn);
      filterView.on(data => {
        setIssueViews(last => ({
          ...last,
          filteredIssues: data,
          hasNonViewFilters,
        }));
      });
      countView.on(data => {
        setIssueViews(last => ({
          ...last,
          issueCount: data,
          hasNonViewFilters,
        }));
      });

      setIssueViews(last => ({
        ...last,
        issueCount: countView.value,
        filteredIssues: filterView.value,
      }));

      const end = performance.now();
      console.log(`Filter update duration: ${end - start}ms`);
      return () => {
        allIssueSet.destroy();
      };
    },
    // stringify the filters to we don't re-run the effect on equal filters.
    [
      priorityFilter?.toString(),
      statusFilter?.toString(),
      allIssueSet,
      view,
      creatorFilter?.toString(),
      createdFilter?.toString(),
      modifiedFilter?.toString(),
    ],
  );

  function onNewDiff(diff: Diff) {
    if (diff.length === 0) {
      return;
    }

    const start = performance.now();
    materialite.tx(() => {
      for (const diffOp of diff) {
        if ('oldValue' in diffOp) {
          allIssueSet.delete(
            issueFromKeyAndValue(diffOp.key as string, diffOp.oldValue),
          );
        }
        if ('newValue' in diffOp) {
          allIssueSet.add(
            issueFromKeyAndValue(diffOp.key as string, diffOp.newValue),
          );
        }
      }
    });

    const duration = performance.now() - start;
    console.log(`Diff duration: ${duration}ms`);
  }

  const partialSync = useSubscribe<
    PartialSyncState | 'NOT_RECEIVED_FROM_SERVER'
  >(
    rep,
    async (tx: ReadTransaction) => {
      return (await getPartialSyncState(tx)) || 'NOT_RECEIVED_FROM_SERVER';
    },
    'NOT_RECEIVED_FROM_SERVER',
  );
  const partialSyncComplete = partialSync === 'COMPLETE';
  useExclusiveEffect(
    'sync-lock',
    () => {
      console.log('partialSync', partialSync);
      if (!partialSyncComplete) {
        rep.pull();
      }
    },
    [rep, partialSync, partialSyncComplete],
  );

  useEffect(() => {
    const ev = new EventSource(`/api/replicache/poke?channel=poke`);
    ev.onmessage = async () => {
      console.log('Receive poke. Pulling');
      return rep.pull();
    };
    return () => ev.close();
  }, []);

  useEffect(() => {
    return rep.experimentalWatch(onNewDiff, {
      prefix: ISSUE_KEY_PREFIX,
      initialValuesInFirstDiff: true,
    });
  }, [rep]);

  const handleCreateIssue = useCallback(
    async (issue: Omit<Issue, 'kanbanOrder'>, description: Description) => {
      const minKanbanOrderIssue = minBy<Issue>(
        [], // TODO
        // [...state.allIssuesMap.values()],
        issue => issue.kanbanOrder,
      );
      const minKanbanOrder = minKanbanOrderIssue
        ? minKanbanOrderIssue.kanbanOrder
        : null;

      await rep.mutate.putIssue({
        issue: {
          ...issue,
          kanbanOrder: generateKeyBetween(null, minKanbanOrder),
        },
        description,
      });
    },
    [rep.mutate /*state.allIssuesMap*/],
  );
  const handleCreateComment = useCallback(
    async (comment: Comment) => {
      await undoManager.add({
        execute: () => rep.mutate.putIssueComment(comment),
        undo: () => rep.mutate.deleteIssueComment(comment),
      });
    },
    [rep.mutate, undoManager],
  );

  const handleUpdateIssues = useCallback(
    async (issueUpdates: Array<IssueUpdate>) => {
      const uChanges: Array<IssueUpdateWithID> =
        issueUpdates.map<IssueUpdateWithID>(issueUpdate => {
          const undoChanges = pickBy(
            issueUpdate.issue,
            (_, key) => key in issueUpdate.issueChanges,
          );
          const rv: IssueUpdateWithID = {
            id: issueUpdate.issue.id,
            issueChanges: undoChanges,
          };
          const {descriptionUpdate} = issueUpdate;
          if (descriptionUpdate) {
            return {
              ...rv,
              descriptionChange: descriptionUpdate.description,
            };
          }
          return rv;
        });
      await undoManager.add({
        execute: () =>
          rep.mutate.updateIssues(
            issueUpdates.map(({issue, issueChanges, descriptionUpdate}) => {
              const rv: IssueUpdateWithID = {
                id: issue.id,
                issueChanges,
              };
              if (descriptionUpdate) {
                return {
                  ...rv,
                  descriptionChange: descriptionUpdate.description,
                };
              }
              return rv;
            }),
          ),
        undo: () => rep.mutate.updateIssues(uChanges),
      });
    },
    [rep.mutate, undoManager],
  );

  const handleOpenDetail = useCallback(
    async (issue: Issue) => {
      await setDetailIssueID(issue.id);
    },
    [setDetailIssueID],
  );
  const handleCloseMenu = useCallback(
    () => setMenuVisible(false),
    [setMenuVisible],
  );
  const handleToggleMenu = useCallback(
    () => setMenuVisible(!menuVisible),
    [setMenuVisible, menuVisible],
  );

  const handlers = {
    undo: () => undoManager.undo(),
    redo: () => undoManager.redo(),
  };

  return (
    <HotKeys
      {...{
        keyMap,
        handlers,
      }}
    >
      <Layout
        menuVisible={menuVisible}
        view={view}
        detailIssueID={detailIssueID}
        isLoading={!partialSyncComplete}
        state={issueViews}
        rep={rep}
        onCloseMenu={handleCloseMenu}
        onToggleMenu={handleToggleMenu}
        onUpdateIssues={handleUpdateIssues}
        onCreateIssue={handleCreateIssue}
        onCreateComment={handleCreateComment}
        onOpenDetail={handleOpenDetail}
      ></Layout>
    </HotKeys>
  );
};

const keyMap = {
  undo: ['ctrl+z', 'command+z'],
  redo: ['ctrl+y', 'command+shift+z', 'ctrl+shift+z'],
};

export default App;
