// React context for the TallyStore.
//
// Modules that need the relational store (full masters, indexed lookups,
// typed query views) call useTallyStore(). Modules that still consume the
// flat LedgerEntry[] shim ignore this entirely.
//
// Why context and not prop drilling: the store is a singleton per loaded
// dataset, every module potentially wants it, and 20+ prop signatures
// would otherwise need updating. Context keeps each module independent.

import React, { createContext, useContext } from 'react';
import { TallyStore } from './store';

const TallyStoreContext = createContext<TallyStore | null>(null);

export const TallyStoreProvider: React.FC<{
  store: TallyStore | null;
  children: React.ReactNode;
}> = ({ store, children }) =>
  React.createElement(TallyStoreContext.Provider, { value: store }, children);

// Returns the current store, or null if the dataset came from the legacy
// live-loader (which doesn't produce a full relational store). Callers
// must handle null gracefully — typically with a "ZIP import required"
// banner inside the module.
export const useTallyStore = (): TallyStore | null => useContext(TallyStoreContext);
