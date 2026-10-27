// The plugin and External API intentionally share one recurring-Item domain
// implementation so a status transition has identical semantics everywhere.
export {
  computeNextOccurrence,
  isEndReached,
  projectOccurrences,
  rescheduleOnClose,
} from "../../shared/recurring";
