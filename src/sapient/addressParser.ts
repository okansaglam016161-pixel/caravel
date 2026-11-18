// The Tari address parser (@tari-project/ootle-wasm), LOADED ON DEMAND.
//
// Caravel needs it for one thing: reading an `otl_…` address's network byte before a payment
// (payments.assertPayableAddress). The package is a 1.3 MB WebAssembly module initialised with a
// top-level await, so importing it statically made every visitor — landing page included — download
// and start it before anything rendered. Now it is fetched the first time the pay panel opens, and
// a payment cannot be submitted until it is there.

import type { OotleAddressParser } from './payments'

let parser: OotleAddressParser | null = null
let loading: Promise<OotleAddressParser> | null = null

/** Start (or join) the load. A failed load is forgotten, so the next call tries again. */
export function loadAddressParser(): Promise<OotleAddressParser> {
  if (!loading) {
    loading = import('@tari-project/ootle-wasm')
      .then(m => { parser = m.parseOotleAddress; return parser })
      .catch(e => { loading = null; throw e })
  }
  return loading
}

/** The parser once loaded, else null. */
export function addressParser(): OotleAddressParser | null {
  return parser
}
