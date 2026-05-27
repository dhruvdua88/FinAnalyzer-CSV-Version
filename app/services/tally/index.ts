// Public surface of the Tally relational store. App code should import from
// here, not from the individual files — keeps refactor freedom on the
// internal modules.

export { TallyStore } from './store';
export * from './types';
export * from './queries';
export { TallyStoreProvider, useTallyStore } from './StoreContext';
export {
  toText, toNumber, toBool, toIsoDate, nameKey,
  voucherFamilyKey, voucherKey, isPlPrimaryGroup, buildLedgerPrimaryMap,
} from './helpers';

import { TallyStore } from './store';

// Convenience: import a ZIP and return a ready-to-use store.
export const importTallyZip = (file: File | Blob): Promise<TallyStore> =>
  TallyStore.fromZip(file);
