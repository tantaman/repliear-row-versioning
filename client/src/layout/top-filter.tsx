/* eslint-disable @typescript-eslint/naming-convention */
import MenuIcon from '../assets/icons/menu.svg?react';
import {memo} from 'react';

import SortOrderMenu from '../widgets/sort-order-menu';
import FilterMenu from '../widgets/filter-menu';
import {noop} from 'lodash';
import {
  useOrderByState,
  usePriorityFilterState,
  useStatusFilterState,
} from '../hooks/query-state-hooks';
import {Priority, Status} from 'shared';

interface Props {
  title: string;
  onToggleMenu?: (() => void) | undefined;
  filteredIssuesCount?: number | undefined;
  issuesCount: number;
  showSortOrderMenu: boolean;
}

interface FilterStatusProps {
  filter: Status[] | Priority[] | null;
  onDelete: () => void;
  label: string;
}

const displayStrings: Record<Priority | Status, string> = {
  NONE: 'None',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',

  BACKLOG: 'Backlog',
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
  CANCELED: 'Canceled',
};

const FilterStatus = ({filter, onDelete, label}: FilterStatusProps) => {
  if (!filter || filter.length === 0) return null;
  return (
    <div className="flex items-center pr-4 space-x-[1px]">
      <span className="px-1 text-gray-50 bg-gray-850 rounded-l">
        {label} is
      </span>
      <span className="px-1 text-gray-50 bg-gray-850 ">
        {filter.map(f => displayStrings[f]).join(', ')}
      </span>
      <span
        className="px-1 text-gray-50 bg-gray-850 rounded-r cursor-pointer"
        onMouseDown={onDelete}
      >
        &times;
      </span>
    </div>
  );
};

const TopFilter = ({
  title,
  onToggleMenu = noop,
  filteredIssuesCount,
  issuesCount,
  showSortOrderMenu,
}: Props) => {
  const [orderBy, setOrderByParam] = useOrderByState();
  const [statusFilters, setStatusFilterByParam] = useStatusFilterState();
  const [priorityFilters, setPriorityFilterByParam] = usePriorityFilterState();

  return (
    <>
      <div className="flex justify-between flex-shrink-0 pl-2 lg:pl-9 pr-2 lg:pr-6 border-b border-gray-850 h-14 border-b-color-gray-50">
        {/* left section */}
        <div className="flex items-center">
          <button
            className="flex-shrink-0 h-full px-5 focus:outline-none lg:hidden"
            onClick={onToggleMenu}
          >
            <MenuIcon className="w-3.5 text-white hover:text-gray-50" />
          </button>
          <div className="p-1 font-semibold cursor-default">{title}</div>
          {filteredIssuesCount ? (
            <span>
              {filteredIssuesCount} / {issuesCount}
            </span>
          ) : (
            <span>{issuesCount}</span>
          )}
          <FilterMenu
            onSelectPriority={async priority => {
              const prioritySet = new Set(priorityFilters);
              if (prioritySet.has(priority)) {
                prioritySet.delete(priority);
              } else {
                prioritySet.add(priority);
              }
              await setPriorityFilterByParam(
                prioritySet.size === 0 ? null : [...prioritySet],
              );
            }}
            onSelectStatus={async status => {
              const statusSet = new Set(statusFilters);
              if (statusSet.has(status)) {
                statusSet.delete(status);
              } else {
                statusSet.add(status);
              }
              await setStatusFilterByParam(
                statusSet.size === 0 ? null : [...statusSet],
              );
            }}
          />
        </div>

        {/* right section */}
        <div className="flex items-center">
          {showSortOrderMenu && (
            <SortOrderMenu
              onSelect={orderBy => setOrderByParam(orderBy)}
              order={orderBy || 'MODIFIED'}
            />
          )}
        </div>
      </div>
      {(statusFilters && statusFilters.length) ||
      (priorityFilters && priorityFilters.length) ? (
        <div className="flex pl-2 lg:pl-9 pr-6 border-b border-gray-850 h-8">
          <FilterStatus
            filter={statusFilters}
            onDelete={() => setStatusFilterByParam(null)}
            label="Status"
          />
          <FilterStatus
            filter={priorityFilters}
            onDelete={() => setPriorityFilterByParam(null)}
            label="Priority"
          />
        </div>
      ) : null}
    </>
  );
};

export default memo(TopFilter);
