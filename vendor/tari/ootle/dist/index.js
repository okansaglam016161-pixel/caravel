var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { aggregateInputMasks as e, borEncodeTransaction as t, buildStealthInputsStatement as n, createStealthOutputWitness as r, encryptedDataDhKdfAead as i, generateKeypair as a, generateStealthBalanceProofSignature as o, generateStealthOutputsStatement as s, parseOotleAddress as c, sealTransaction as l, stealthDhSecret as u, unblindOutput as ee, validateBalanceProofSignature as te, validateStealthTransfer as ne } from "@tari-project/ootle-wasm";
var d = /* @__PURE__ */ (function(e11) {
  return e11[e11.MainNet = 0] = "MainNet", e11[e11.StageNet = 1] = "StageNet", e11[e11.NextNet = 2] = "NextNet", e11[e11.LocalNet = 16] = "LocalNet", e11[e11.Igor = 36] = "Igor", e11[e11.Esmeralda = 38] = "Esmeralda", e11;
})({}), f = class extends Error {
  constructor(e11, t2) {
    super(e11, t2), this.name = new.target.name;
  }
}, re = class extends f {
  constructor(e11, t2) {
    super(e11, t2);
    __publicField(this, "status");
    __publicField(this, "body");
    __publicField(this, "url");
    this.status = t2 == null ? void 0 : t2.status, this.body = t2 == null ? void 0 : t2.body, this.url = t2 == null ? void 0 : t2.url;
  }
}, ie = class extends f {
  constructor(e11, t2) {
    super(e11, t2);
    __publicField(this, "txId");
    __publicField(this, "reason");
    __publicField(this, "rejectReason");
    this.txId = t2.txId, this.reason = t2.reason, this.rejectReason = t2.rejectReason;
  }
}, ae = class extends f {
  constructor(e11, t2) {
    super(e11, t2);
    __publicField(this, "txId");
    this.txId = t2.txId;
  }
}, p = class extends f {
}, m = class extends p {
  constructor(e11, t2) {
    super(e11, t2);
    __publicField(this, "address");
    this.address = t2.address;
  }
}, h = class extends p {
}, g = class extends f {
}, _ = class extends f {
  constructor(e11, t2) {
    super(e11, t2);
    __publicField(this, "context");
    this.context = t2 == null ? void 0 : t2.context;
  }
}, v = class extends f {
}, oe = class extends f {
};
function se(e11, t2) {
  throw new v(`assertUnreachable${t2 ? ` (${t2})` : ""}: ${JSON.stringify(e11)}`);
}
function y(e11, t2, n2) {
  if (e11.length !== t2) throw new v(`${n2} must be ${t2} bytes, got ${e11.length}`);
  return e11;
}
function b(e11) {
  return Array.from(e11, (e12) => e12.toString(16).padStart(2, "0")).join("");
}
var ce = /^[0-9a-fA-F]*$/;
function x(e11) {
  if (e11.length % 2 != 0) throw new v(`fromHexStr: hex string must have even length, got ${e11.length}`);
  if (!ce.test(e11)) throw new v("fromHexStr: hex string contains non-hex characters");
  let t2 = new Uint8Array(e11.length / 2);
  for (let n2 = 0; n2 < t2.length; n2++) t2[n2] = parseInt(e11.substring(n2 * 2, n2 * 2 + 2), 16);
  return t2;
}
var S = (1n << 64n) - 1n, C = 32, le = C * 2, ue = 32, de = 128, fe = 129, pe = 130, me = 131, he = 132, ge = 136, _e = 137, ve = 138, ye = 141, w = 0, be = 32, T = 64, xe = 96, E = 128, Se = 160, D = 192;
function Ce(e11) {
  switch (typeof e11) {
    case "bigint":
      return O(e11);
    case "string":
      return Te(e11);
    case "boolean":
      return Ee(e11);
    default:
      if (e11 instanceof Uint8Array) return k(e11);
      throw new v(`literalArg: cannot CBOR-encode value of type ${typeof e11}`);
  }
}
function O(e11) {
  if (e11 < 0n) throw new v(`amountLiteral: amount must be non-negative, got ${e11}`);
  if (e11 >> 128n != 0n) throw new v(`amountLiteral: amount overflows u128: ${e11}`);
  let t2 = [];
  return P(t2, E, 2n), P(t2, w, e11 & S), P(t2, w, e11 >> 64n & S), F(t2);
}
function we(e11) {
  let t2 = [];
  if (e11 >= 0n) {
    if (e11 > S) throw new v(`intLiteral: value exceeds the 64-bit CBOR integer range: ${e11}`);
    P(t2, w, e11);
  } else {
    let n2 = -1n - e11;
    if (n2 > S) throw new v(`intLiteral: value exceeds the 64-bit CBOR integer range: ${e11}`);
    P(t2, be, n2);
  }
  return F(t2);
}
function Te(e11) {
  let t2 = [];
  return M(t2, e11), F(t2);
}
function k(e11) {
  let t2 = [];
  return P(t2, T, BigInt(e11.length)), N(t2, e11), F(t2);
}
function Ee(e11) {
  return { Literal: e11 ? "f5" : "f4" };
}
function A(e11) {
  return j(me, e11, "resource_");
}
function De(e11) {
  return j(de, e11, "component_");
}
function Oe(e11) {
  let t2 = e11 instanceof Map ? e11 : new Map(Object.entries(e11)), n2 = new TextEncoder(), r2 = [...t2.entries()].sort(([e12], [t3]) => ze(n2.encode(e12), n2.encode(t3))), i2 = [];
  P(i2, D, BigInt(fe)), P(i2, Se, BigInt(r2.length));
  for (let [e12, t3] of r2) M(i2, e12), M(i2, t3);
  return F(i2);
}
function ke(e11) {
  return j(he, e11, "vault_");
}
function Ae(e11) {
  return j(_e, e11, "template_");
}
function je(e11) {
  return j(ge, e11, "tombstone_");
}
function Me(e11) {
  return j(ve, e11, "vnfp_");
}
function Ne(e11) {
  let t2 = typeof e11 == "string" ? x(e11) : e11;
  return y(t2, ue, "publicKeyLiteral"), k(t2);
}
function Pe(e11) {
  let t2 = [];
  return P(t2, D, BigInt(pe)), P(t2, E, 2n), Ie(t2, me, e11.resource_address, "resource_"), Le(t2, e11.id), F(t2);
}
function Fe(e11) {
  let t2 = [];
  P(t2, D, BigInt(ye)), P(t2, E, 2n), Ie(t2, me, e11.resource_address, "resource_");
  let n2 = x(e11.id);
  return y(n2, C, "utxoAddressLiteral: id"), P(t2, T, BigInt(C)), N(t2, n2), F(t2);
}
function j(e11, t2, n2) {
  let r2 = [];
  return Ie(r2, e11, t2, n2), F(r2);
}
function Ie(e11, t2, n2, r2) {
  let i2 = n2.startsWith(r2) ? n2.slice(r2.length) : n2;
  if (i2.length !== le) throw new v(`${r2}address must be 32 bytes (${le} hex chars), got ${i2.length}`);
  P(e11, D, BigInt(t2)), P(e11, T, BigInt(C)), N(e11, x(i2));
}
function Le(e11, t2) {
  if (P(e11, E, 2n), "U256" in t2) {
    P(e11, w, 0n), P(e11, E, 1n);
    let n2 = x(t2.U256);
    y(n2, C, "NonFungibleId.U256"), P(e11, T, BigInt(C)), N(e11, n2);
  } else if ("String" in t2) P(e11, w, 1n), P(e11, E, 1n), M(e11, t2.String);
  else if ("Uint32" in t2) P(e11, w, 2n), P(e11, E, 1n), Re(e11, t2.Uint32, "NonFungibleId.Uint32", (1n << 32n) - 1n);
  else if ("Uint64" in t2) P(e11, w, 3n), P(e11, E, 1n), Re(e11, t2.Uint64, "NonFungibleId.Uint64", S);
  else throw new v(`nonFungibleAddressLiteral: unrecognised NonFungibleId variant: ${JSON.stringify(t2)}`);
}
function Re(e11, t2, n2, r2) {
  if (!Number.isInteger(t2) || t2 < 0) throw new v(`${n2} must be a non-negative integer, got ${t2}`);
  if (r2 > BigInt(2 ** 53 - 1) && t2 > 2 ** 53 - 1) throw new v(`${n2} value ${t2} exceeds Number.MAX_SAFE_INTEGER (2^53-1) and cannot be encoded without precision loss \u2014 the binding types this id as a JS number. Use a U256/String id for large values.`);
  let i2 = BigInt(t2);
  if (i2 > r2) throw new v(`${n2} value ${t2} exceeds its maximum of ${r2}`);
  P(e11, w, i2);
}
function M(e11, t2) {
  let n2 = new TextEncoder().encode(t2);
  P(e11, xe, BigInt(n2.length)), N(e11, n2);
}
function N(e11, t2) {
  let n2 = e11.length;
  e11.length = n2 + t2.length;
  for (let r2 = 0; r2 < t2.length; r2++) e11[n2 + r2] = t2[r2];
}
function ze(e11, t2) {
  let n2 = Math.min(e11.length, t2.length);
  for (let r2 = 0; r2 < n2; r2++) if (e11[r2] !== t2[r2]) return e11[r2] < t2[r2] ? -1 : 1;
  return e11.length - t2.length;
}
function P(e11, t2, n2) {
  n2 < 24n ? e11.push(t2 | Number(n2)) : n2 < 1n << 8n ? e11.push(t2 | 24, Number(n2)) : n2 < 1n << 16n ? e11.push(t2 | 25, Number(n2 >> 8n & 255n), Number(n2 & 255n)) : n2 < 1n << 32n ? e11.push(t2 | 26, Number(n2 >> 24n & 255n), Number(n2 >> 16n & 255n), Number(n2 >> 8n & 255n), Number(n2 & 255n)) : e11.push(t2 | 27, Number(n2 >> 56n & 255n), Number(n2 >> 48n & 255n), Number(n2 >> 40n & 255n), Number(n2 >> 32n & 255n), Number(n2 >> 24n & 255n), Number(n2 >> 16n & 255n), Number(n2 >> 8n & 255n), Number(n2 & 255n));
}
function F(e11) {
  return { Literal: b(Uint8Array.from(e11)) };
}
function I(e11) {
  return O(e11);
}
function Be(e11) {
  if (e11 < 0n) throw new v(`microTariString: amount must be non-negative, got ${e11}`);
  return e11.toString();
}
function Ve(e11) {
  let t2 = e11.split(".");
  if (t2.length > 2) throw new v("Invalid workspace key format. Only one dot is allowed.");
  let n2 = t2[0];
  if (t2[1] === void 0) return {
    name: n2,
    offset: null
  };
  let r2 = Number.parseInt(t2[1], 10);
  if (Number.isNaN(r2) || r2 < 0 || String(r2) !== t2[1]) throw new v(`Invalid workspace key offset: "${t2[1]}"`);
  return {
    name: n2,
    offset: r2
  };
}
function He(e11) {
  return e11.startsWith("template_") ? e11.slice(9) : e11;
}
function Ue(e11) {
  return new v(`No workspace variable named "${e11}" has been defined. Call builder.saveVar(${JSON.stringify(e11)}) on a preceding instruction whose output you want to reference.`);
}
var L = class e2 {
  constructor(e11) {
    __publicField(this, "unsignedTransaction");
    __publicField(this, "allocatedIds");
    __publicField(this, "currentId");
    this.unsignedTransaction = {
      network: e11,
      fee_instructions: [],
      instructions: [],
      inputs: [],
      min_epoch: null,
      max_epoch: null,
      dry_run: false,
      is_seal_signer_authorized: false,
      blobs: []
    }, this.allocatedIds = /* @__PURE__ */ new Map(), this.currentId = 0;
  }
  static new(t2) {
    return new e2(t2);
  }
  callFunction(e11, t2) {
    let n2 = this.resolveArgs(t2);
    return this.addInstruction({ CallFunction: {
      address: He(e11.templateAddress),
      function: e11.functionName,
      args: n2
    } });
  }
  callMethod(e11, t2) {
    let n2;
    if (e11.componentAddress) n2 = { Address: e11.componentAddress };
    else if (e11.fromWorkspace) n2 = { Workspace: this.requireNamedId(e11.fromWorkspace) };
    else throw new v("callMethod requires either `componentAddress` or `fromWorkspace` to be set on the method definition. Use `fromWorkspace` to call a method on a component returned by a previous saveVar; use `componentAddress` for an on-chain component.");
    let r2 = this.resolveArgs(t2);
    return this.addInstruction({ CallMethod: {
      call: n2,
      method: e11.methodName,
      args: r2
    } });
  }
  createAccount(e11, t2) {
    let n2 = t2 ? this.getOffsetIdFromWorkspaceName(t2) : null;
    return this.addInstruction({ CreateAccount: {
      owner_public_key: e11,
      owner_rule: null,
      access_rules: null,
      bucket_workspace_id: n2
    } });
  }
  createProof(e11, t2) {
    return this.addInstruction({ CallMethod: {
      call: { Address: e11 },
      method: "create_proof_for_resource",
      args: [A(t2)]
    } });
  }
  claimBurn(e11, t2) {
    return this.addInstruction({ ClaimBurn: {
      claim: e11,
      output_data: t2
    } });
  }
  allocateAddress(e11, t2) {
    let n2 = this.addNamedId(t2);
    return this.addInstruction({ AllocateAddress: {
      allocatable_type: e11,
      workspace_id: n2
    } });
  }
  saveVar(e11) {
    let t2 = this.addNamedId(e11);
    return this.addInstruction({ PutLastInstructionOutputOnWorkspace: { key: t2 } });
  }
  feeTransactionPayFromComponent(e11, t2) {
    return this.addFeeInstruction({ CallMethod: {
      call: { Address: e11 },
      method: "pay_fee",
      args: [I(t2)]
    } });
  }
  feeTransactionPayFromComponentConfidential(e11, t2) {
    throw new v("feeTransactionPayFromComponentConfidential is not implemented: a ConfidentialWithdrawProof Literal must be tari_bor-CBOR-encoded, which the TS SDK does not yet support.");
  }
  dropAllProofsInWorkspace() {
    return this.addInstruction("DropAllProofsInWorkspace");
  }
  publishTemplate(e11, t2 = null) {
    let n2 = this.unsignedTransaction.blobs.length;
    return this.unsignedTransaction.blobs.push(e11), this.addInstruction({ PublishTemplate: {
      binary: n2,
      metadata_hash: t2
    } });
  }
  addInstruction(e11) {
    return this.unsignedTransaction.instructions.push(e11), this;
  }
  addFeeInstruction(e11) {
    return this.unsignedTransaction.fee_instructions.push(e11), this;
  }
  withInstructions(e11) {
    return this.unsignedTransaction.instructions.push(...e11), this;
  }
  withFeeInstructions(e11) {
    return this.unsignedTransaction.fee_instructions.push(...e11), this;
  }
  withFeeInstructionsBuilder(t2) {
    let n2 = t2(new e2(this.unsignedTransaction.network));
    return this.unsignedTransaction.fee_instructions = n2.unsignedTransaction.instructions, this;
  }
  addInput(e11) {
    return this.unsignedTransaction.inputs.push(e11), this;
  }
  withInputs(e11) {
    return this.unsignedTransaction.inputs.push(...e11), this;
  }
  withMinEpoch(e11) {
    return this.unsignedTransaction.min_epoch = e11, this;
  }
  withMaxEpoch(e11) {
    return this.unsignedTransaction.max_epoch = e11, this;
  }
  withUnsignedTransaction(e11) {
    return this.unsignedTransaction = {
      ...e11,
      blobs: e11.blobs ?? []
    }, this.allocatedIds = /* @__PURE__ */ new Map(), this.currentId = 0, this;
  }
  resolveWorkspaceOffsetId(e11) {
    return this.getOffsetIdFromWorkspaceName(e11);
  }
  buildUnsignedTransaction() {
    return {
      ...this.unsignedTransaction,
      instructions: [...this.unsignedTransaction.instructions],
      fee_instructions: [...this.unsignedTransaction.fee_instructions],
      inputs: [...this.unsignedTransaction.inputs],
      blobs: [...this.unsignedTransaction.blobs]
    };
  }
  addNamedId(e11) {
    let t2 = this.currentId;
    return this.allocatedIds.set(e11, t2), this.currentId += 1, t2;
  }
  requireNamedId(e11) {
    let t2 = this.allocatedIds.get(e11);
    if (t2 === void 0) throw Ue(e11);
    return t2;
  }
  getOffsetIdFromWorkspaceName(e11) {
    let t2 = Ve(e11);
    return {
      id: this.requireNamedId(t2.name),
      offset: t2.offset
    };
  }
  resolveArgs(e11) {
    return e11.map((e12) => typeof e12 == "object" && e12 && "Workspace" in e12 && typeof e12.Workspace == "string" ? { Workspace: this.getOffsetIdFromWorkspaceName(e12.Workspace) } : e12);
  }
}, We = {
  [d.LocalNet]: "http://localhost:12500",
  [d.Esmeralda]: "https://ootle-indexer-a.tari.com"
};
function Ge(e11) {
  let t2 = We[e11];
  if (t2 !== void 0) return t2;
  throw new v(`No default indexer URL is configured for ${d[e11]}. Pass an explicit URL via ProviderBuilder.withUrl(...) or IndexerProvider.connect({ url, network: Network.${d[e11]} }).`);
}
var Ke = 132, qe = 32;
function* Je(e11) {
  let t2 = /* @__PURE__ */ new Set();
  for (let n2 of R(e11, Ke)) n2.length === qe * 2 && !t2.has(n2) && (t2.add(n2), yield `vault_${n2}`);
}
async function Ye(e11, t2) {
  let n2 = (await e11.getSubstate(t2)).substate;
  return Ze(n2) ? Array.from(Je(n2.Component.body.state)) : [];
}
function* R(e11, t2) {
  if (Array.isArray(e11)) {
    for (let n3 of e11) yield* R(n3, t2);
    return;
  }
  if (typeof e11 != "object" || !e11) return;
  let n2 = e11, r2 = n2["@cbor"];
  if (typeof r2 == "string") {
    if (r2 === "tag") {
      let e12 = n2.value;
      if (n2.tag === t2) {
        let t3 = Xe(e12);
        t3 !== null && (yield t3);
      }
      yield* R(e12, t2);
    } else if (r2 === "map") {
      let e12 = n2.entries;
      if (Array.isArray(e12)) for (let n3 of e12) Array.isArray(n3) && n3.length === 2 && (yield* R(n3[0], t2), yield* R(n3[1], t2));
    }
    return;
  }
  for (let e12 of Object.values(n2)) yield* R(e12, t2);
}
function Xe(e11) {
  if (typeof e11 != "object" || !e11) return null;
  let t2 = e11;
  if (t2["@cbor"] !== "bytes") return null;
  let n2 = t2.hex;
  return typeof n2 == "string" ? n2 : null;
}
function Ze(e11) {
  return typeof e11 == "object" && !!e11 && "Component" in e11;
}
var Qe = "resource_0101010101010101010101010101010101010101010101010101010101010101", $e = "component_0102030000000000000000000000000000000000000000000000000000000000", et = "vault_0102030000000000000000000000000000000000000000000000000000000001", tt = "resource_0102030000000000000000000000000000000000000000000000000000000002", nt = "__ootleRawJson", rt = "stealth_revealed_input", it = "stealth_revealed_change";
function z(e11, t2) {
  let n2 = e11.revealedInputBucket === null ? null : t2(e11.revealedInputBucket);
  return { StealthTransfer: {
    resource_address_ref: { Address: e11.resourceAddress },
    statement: B(e11.statement),
    revealed_input_bucket: n2
  } };
}
function B(e11) {
  return { [nt]: e11.toCompactJson() };
}
function V(e11) {
  return typeof e11 == "object" && !!e11 && "StealthTransfer" in e11;
}
function H(e11) {
  let t2 = [], n2 = (e12) => `__ootleRawJson:${e12}__`, r2 = JSON.stringify(e11, (e12, r3) => {
    if (typeof r3 == "object" && r3 && "__ootleRawJson" in r3) {
      let e13 = n2(t2.length);
      return t2.push(r3[nt]), e13;
    }
    return r3;
  });
  for (let e12 = 0; e12 < t2.length; e12++) {
    let i2 = JSON.stringify(n2(e12)), a2 = r2.indexOf(i2);
    if (a2 < 0) throw new v(`serializeUnsignedTx: raw-JSON placeholder ${e12} was not emitted`);
    if (r2.indexOf(i2, a2 + i2.length) >= 0) throw new v(`serializeUnsignedTx: raw-JSON placeholder ${e12} collided with transaction data`);
    r2 = r2.slice(0, a2) + t2[e12] + r2.slice(a2 + i2.length);
  }
  return r2;
}
async function U(e11, t2) {
  let n2 = await e11.resolveInputs(t2.inputs);
  return {
    ...t2,
    inputs: n2
  };
}
function at() {
  let { secret_key: e11, public_key: t2 } = a();
  return {
    secret_key: e11,
    public_key: t2
  };
}
function ot(e11, t2) {
  return {
    public_key: b(y(e11, 32, "publicKey")),
    signature: {
      public_nonce: b(y(t2.public_nonce, 32, "schnorr.public_nonce")),
      signature: b(y(t2.signature, 32, "schnorr.signature"))
    }
  };
}
async function W(e11, t2, n2) {
  let r2 = n2 ?? a(), i2 = y(r2.secret_key, 32, "sealKeypair.secret_key"), o2 = y(r2.public_key, 32, "sealKeypair.public_key"), s2 = [];
  for (let n3 of e11) {
    let e12 = await n3.signTransaction(t2, o2);
    s2.push(...e12);
  }
  let c2 = l(`{"transaction":${H(t2)},"signatures":${JSON.stringify(s2)}}`, i2);
  return {
    sealedJson: c2,
    transaction: JSON.parse(c2)
  };
}
function G(e11) {
  return t(e11.sealedJson);
}
async function st(e11, t2) {
  return (await e11.submitTransaction(t2)).transaction_id;
}
function ct(e11) {
  var _a, _b;
  if (e11 === "Pending" || !("Finalized" in e11)) return null;
  let t2 = e11.Finalized, n2 = t2.final_decision;
  if (n2 === null) return null;
  if (n2 === "Commit") return { outcome: n2 };
  if (typeof n2 == "object" && n2 && "Abort" in n2) {
    let e12 = t2.abort_details ?? JSON.stringify(n2.Abort), r2 = (_b = (_a = t2.execution_result) == null ? void 0 : _a.finalize) == null ? void 0 : _b.result;
    return typeof r2 == "object" && r2 && "AcceptFeeRejectRest" in r2 ? {
      outcome: "FeeIntentCommit",
      reason: e12
    } : {
      outcome: "Reject",
      reason: e12
    };
  }
  throw new v(`Unexpected final_decision variant: ${JSON.stringify(n2)}`);
}
async function lt(e11, t2, n2) {
  let r2 = (n2 == null ? void 0 : n2.pollIntervalMs) ?? 500, i2 = (n2 == null ? void 0 : n2.timeoutMs) ?? 6e4, a2 = Date.now() + i2;
  for (; ; ) {
    let n3 = await e11.getTransactionResult(t2), o2 = n3.result;
    if (o2 !== "Pending" && "Finalized" in o2) {
      let { outcome: e12, reason: r3 } = ct(o2) ?? { outcome: "Reject" };
      if (e12 === "Reject") throw new ie(`Transaction ${t2} was rejected: ${r3}`, {
        txId: t2,
        reason: r3 ?? ""
      });
      if (e12 === "FeeIntentCommit") throw new ie(`Transaction ${t2} only committed fees (execution aborted): ${r3}`, {
        txId: t2,
        reason: `FeeIntentCommit: ${r3 ?? ""}`
      });
      return n3;
    }
    if (Date.now() >= a2) throw new ae(`Transaction ${t2} did not finalize within ${i2}ms`, { txId: t2 });
    await new Promise((e12) => setTimeout(e12, r2));
  }
}
async function ut(e11, t2, n2, r2) {
  let i2 = await U(e11, n2);
  return lt(e11, await st(e11, G(await W(Array.isArray(t2) ? t2 : [t2], i2))), r2);
}
async function dt(e11, t2, n2, r2) {
  return ut(e11, t2, {
    ...n2,
    dry_run: true
  }, r2);
}
var ft = class {
  constructor(e11) {
    __publicField(this, "builder");
    this.builder = L.new(e11);
  }
  withInputs(e11) {
    return this.builder.withInputs(e11), this;
  }
  feeTransactionPayFromComponent(e11, t2) {
    return this.builder.feeTransactionPayFromComponent(e11, t2), this;
  }
  publicTransfer(e11, t2, n2, r2) {
    return this.builder.callMethod({
      componentAddress: e11,
      methodName: "withdraw"
    }, [A(t2), I(n2)]).saveVar("bucket").callMethod({
      componentAddress: r2,
      methodName: "deposit"
    }, [{ Workspace: "bucket" }]), this;
  }
  publishTemplate(e11, t2, n2) {
    return this.builder.publishTemplate(t2), n2 && this.builder.saveVar(n2), this;
  }
  build() {
    return this.builder.buildUnsignedTransaction();
  }
}, pt = class {
  constructor(e11, t2) {
    __publicField(this, "builder");
    __publicField(this, "faucetAddress");
    this.builder = L.new(e11), this.faucetAddress = t2;
  }
  feeTransactionPayFromComponent(e11, t2) {
    return this.builder.feeTransactionPayFromComponent(e11, t2), this;
  }
  takeFaucetFunds(e11, t2) {
    return this.builder.callMethod({
      componentAddress: this.faucetAddress,
      methodName: "take_free_coins"
    }, [I(t2)]).saveVar("faucet_bucket").callMethod({
      componentAddress: e11,
      methodName: "deposit"
    }, [{ Workspace: "faucet_bucket" }]), this;
  }
  takeMaxFaucetFunds(e11) {
    return this.builder.callMethod({
      componentAddress: this.faucetAddress,
      methodName: "take_max_free_coins"
    }, []).saveVar("faucet_bucket").callMethod({
      componentAddress: e11,
      methodName: "deposit"
    }, [{ Workspace: "faucet_bucket" }]), this;
  }
  publishTemplate(e11, t2) {
    let n2 = t2 ?? "template";
    return this.builder.callFunction({
      templateAddress: e11,
      functionName: "new"
    }, []).saveVar(n2), this;
  }
  build() {
    return this.builder.buildUnsignedTransaction();
  }
}, mt = class {
  constructor() {
    __publicField(this, "keyProviders");
    __publicField(this, "defaultSignerAddress", null);
    this.keyProviders = /* @__PURE__ */ new Map();
  }
  registerKeyProvider(e11, t2) {
    return this.keyProviders.set(e11, t2), this;
  }
  setDefaultSigner(e11) {
    return this.requireKeyProvider(e11, "explicit"), this.defaultSignerAddress = e11, this;
  }
  async getAddress() {
    if (!this.defaultSignerAddress) throw new h("No default signer address set. Call setDefaultSigner() first.");
    return Promise.resolve(this.defaultSignerAddress);
  }
  async getPublicKey() {
    return this.getSignerOrThrow().getPublicKey();
  }
  async signTransaction(e11, t2) {
    return this.getSignerOrThrow().signTransaction(e11, t2);
  }
  async authorizeTransaction(e11, t2, n2) {
    return {
      signerAddress: e11,
      signatures: await this.requireKeyProvider(e11, "explicit").signTransaction(t2, n2)
    };
  }
  async authorizeTransactionAll(e11, t2) {
    return Promise.all([...this.keyProviders.keys()].map((n2) => this.authorizeTransaction(n2, e11, t2)));
  }
  getKeyProvider(e11) {
    return this.keyProviders.get(e11);
  }
  getSignerAddresses() {
    return [...this.keyProviders.keys()];
  }
  getSignerOrThrow() {
    if (!this.defaultSignerAddress) throw new h("No default signer address set. Call setDefaultSigner() first.");
    return this.requireKeyProvider(this.defaultSignerAddress, "default");
  }
  requireKeyProvider(e11, t2) {
    let n2 = this.keyProviders.get(e11);
    if (n2 === void 0) throw new m(t2 === "default" ? `No key provider registered for default address: ${e11}. Call wallet.registerKeyProvider(address, signer) for that address, or pick a different default with setDefaultSigner(otherAddress).` : `No key provider registered for address: ${e11}. Call wallet.registerKeyProvider(${JSON.stringify(e11)}, signer) before signing.`, { address: e11 });
    return n2;
  }
}, ht = class {
  constructor(e11, t2) {
    __publicField(this, "bytes");
    this.bytes = new Uint8Array(y(e11, 32, t2));
  }
  toBytes() {
    return new Uint8Array(this.bytes);
  }
  toHex() {
    return b(this.bytes);
  }
}, K = class e3 extends ht {
  constructor(e11) {
    super(e11, "Mask");
  }
  static zero() {
    return new e3(new Uint8Array(32));
  }
  static fromBytes(t2) {
    return new e3(t2);
  }
  static fromHex(t2) {
    return new e3(x(t2));
  }
}, gt = class e4 {
  constructor(e11) {
    __publicField(this, "bytes");
    this.bytes = new Uint8Array(e11);
  }
  static fromHex(t2) {
    return new e4(x(t2));
  }
  toBytes() {
    return new Uint8Array(this.bytes);
  }
  toHex() {
    return b(this.bytes);
  }
}, _t = Object.freeze({ StealthPublicKey: Object.freeze({}) });
function vt(e11) {
  if (e11.amount <= 0n) throw new v(`Output amount must be > 0, got ${e11.amount}`);
  return {
    destination: e11.destination,
    amount: e11.amount,
    resourceAddress: e11.resourceAddress,
    resourceViewKey: e11.resourceViewKey === void 0 ? void 0 : new Uint8Array(e11.resourceViewKey),
    memo: e11.memo,
    payTo: e11.payTo ?? _t,
    minimumValuePromise: e11.minimumValuePromise ?? 0n
  };
}
function yt(e11, t2) {
  if (e11.trim() === "") throw new v(`${t2} must be a non-empty decimal string`);
  return BigInt(e11);
}
function bt(e11, t2) {
  let n2 = e11.trim();
  if (!n2.startsWith("{") || !n2.endsWith("}")) throw new v(`StealthTransferStatement.toCompactJson: ${t2} fragment is not a JSON object (got: ${e11.slice(0, 60)}...)`);
}
var q = class e5 extends ht {
  constructor(e11) {
    super(e11, "StealthInput.commitment");
  }
  get commitment() {
    return this.toBytes();
  }
  toJSON() {
    return { commitment: this.toHex() };
  }
  static fromJSON(t2) {
    return new e5(x(t2.commitment));
  }
}, xt = class e6 {
  constructor(e11, t2) {
    __publicField(this, "_publicNonce");
    __publicField(this, "_signature");
    this._publicNonce = new Uint8Array(y(e11, 32, "BalanceProofSignature.publicNonce")), this._signature = new Uint8Array(y(t2, 32, "BalanceProofSignature.signature"));
  }
  get publicNonce() {
    return new Uint8Array(this._publicNonce);
  }
  get signature() {
    return new Uint8Array(this._signature);
  }
  toJSON() {
    return {
      public_nonce: b(this._publicNonce),
      signature: b(this._signature)
    };
  }
  static fromJSON(t2) {
    return new e6(x(t2.public_nonce), x(t2.signature));
  }
}, St = class e7 {
  constructor(e11, t2, n2) {
    __publicField(this, "inputs");
    __publicField(this, "revealedAmount");
    __publicField(this, "statementJson");
    this.inputs = e11, this.revealedAmount = t2, this.statementJson = n2;
  }
  static revealedOnly(t2) {
    return new e7([], t2);
  }
  toJSON() {
    return {
      inputs: this.inputs.map((e11) => e11.toJSON()),
      revealed_amount: Be(this.revealedAmount)
    };
  }
  static fromJSON(t2) {
    return new e7(t2.inputs.map(q.fromJSON), yt(t2.revealed_amount, "revealed_amount"));
  }
}, J = class e8 {
  constructor(e11) {
    __publicField(this, "statementJson");
    this.statementJson = e11;
  }
  parsed() {
    return JSON.parse(this.statementJson);
  }
  toJSON() {
    return this.statementJson;
  }
  static fromJSON(t2) {
    return new e8(t2);
  }
}, Y = class e9 {
  constructor(e11, t2, n2) {
    __publicField(this, "inputsStatement");
    __publicField(this, "outputsStatement");
    __publicField(this, "balanceProof");
    this.inputsStatement = e11, this.outputsStatement = t2, this.balanceProof = n2;
  }
  toJSON() {
    let e11 = {
      inputs: this.inputsStatement.toJSON(),
      outputs: this.outputsStatement.toJSON()
    };
    return this.balanceProof !== void 0 && (e11.balance_proof = this.balanceProof.toJSON()), e11;
  }
  toCompactJson() {
    let e11 = this.inputsStatement.statementJson ?? JSON.stringify(this.inputsStatement.toJSON()), t2 = this.outputsStatement.statementJson;
    bt(e11, "inputs_statement"), bt(t2, "outputs_statement");
    let n2 = `{"inputs_statement":${e11},"outputs_statement":${t2}`;
    return this.balanceProof !== void 0 && (n2 += `,"balance_proof":${JSON.stringify(this.balanceProof.toJSON())}`), n2 + "}";
  }
  static fromJSON(t2) {
    return new e9(St.fromJSON(t2.inputs), J.fromJSON(t2.outputs), t2.balance_proof === void 0 ? void 0 : xt.fromJSON(t2.balance_proof));
  }
};
function Ct(e11, t2) {
  let n2 = new Uint8Array(e11.length * 32);
  for (let r2 = 0; r2 < e11.length; r2++) {
    let i2 = e11[r2];
    y(i2, 32, `${t2}[${r2}]`), n2.set(i2, r2 * 32);
  }
  return n2;
}
var wt = class {
  constructor(e11 = d.LocalNet) {
    __publicField(this, "network");
    this.network = e11;
  }
  async generateOutputsStatement(e11, t2) {
    let n2 = s(`[${e11.map((e12) => this.outputWitness(e12)).join(",")}]`, t2);
    return y(n2.aggregated_output_mask, 32, "StealthOutputsResult.aggregated_output_mask"), {
      statement: J.fromJSON(n2.statement_json),
      outputMask: K.fromBytes(n2.aggregated_output_mask)
    };
  }
  outputWitness(e11) {
    let t2 = c(e11.destination), n2 = Tt(e11.payTo) ? null : JSON.stringify(e11.payTo), i2 = e11.memo === void 0 ? null : JSON.stringify(e11.memo), a2 = e11.resourceViewKey ?? null;
    return r(this.network, t2.owner_key, t2.view_key, e11.amount, e11.resourceAddress, a2, i2, n2, e11.minimumValuePromise);
  }
  async buildInputsStatement(e11, t2) {
    return new St(e11, t2, n(Ct(e11.map((e12) => e12.commitment), "input commitment"), t2));
  }
  async generateBalanceProofSignature(e11, t2, n2, r2) {
    let i2 = o(e11.toBytes(), t2.toBytes(), n2, r2);
    return y(i2.public_nonce, 32, "balance proof public_nonce"), y(i2.signature, 32, "balance proof signature"), new xt(i2.public_nonce, i2.signature);
  }
  async validateBalanceProofSignature(e11, t2, n2) {
    return te(e11.publicNonce, e11.signature, t2, n2);
  }
  async deriveAeadKey(e11, t2) {
    y(e11, 32, "deriveAeadKey privateKey"), y(t2, 32, "deriveAeadKey publicKey");
    let n2 = i(e11, t2);
    return y(n2, 32, "derived AEAD key"), n2;
  }
  async unblindOutput(e11, t2, n2, r2) {
    y(e11, 32, "unblindOutput commitment"), y(n2, 32, "unblindOutput aeadKey");
    let i2 = ee(e11, t2, n2, r2);
    return {
      mask: K.fromBytes(i2.mask),
      value: i2.value,
      memo: i2.memo_json ?? void 0
    };
  }
  async aggregateInputMasks(t2) {
    let n2 = e(Ct(t2.map((e11) => e11.toBytes()), "input mask"));
    return K.fromBytes(n2);
  }
  async stealthDhSecret(e11, t2, n2) {
    y(t2, 32, "stealthDhSecret ownerSecret"), y(n2, 32, "stealthDhSecret publicNonce");
    let r2 = u(e11, t2, n2);
    return y(r2, 32, "stealth DH secret"), r2;
  }
  async validateTransfer(e11) {
    ne(e11.toCompactJson(), null);
  }
};
function Tt(e11) {
  let t2 = Object.keys(e11);
  if (t2.length !== 1 || t2[0] !== "StealthPublicKey") return false;
  let n2 = e11.StealthPublicKey;
  return typeof n2 == "object" && !!n2 && Object.keys(n2).length === 0;
}
var Et = "utxo";
function X(e11, t2) {
  return `${Et}_${e11.startsWith("resource_") ? e11.slice(9) : e11}_${b(t2)}`;
}
var Dt = 64;
function Ot(e11) {
  return typeof e11 == "object" && !!e11 && "Utxo" in e11;
}
function kt(e11) {
  return e11.length > 0 && /^[0-9a-fA-F]+$/.test(e11);
}
function At(e11) {
  let t2 = e11.split("_");
  if (t2.length < 3 || t2[0] !== Et) return null;
  let n2 = t2[t2.length - 1];
  return n2.length !== Dt || !kt(n2) ? null : x(n2);
}
function Z(e11, t2) {
  let n2 = e11.substate;
  if (!Ot(n2)) return null;
  let r2 = n2.Utxo;
  if (r2.output === null || r2.is_frozen) return null;
  let i2 = At(t2);
  return i2 === null ? null : {
    commitment: i2,
    body: r2.output.output
  };
}
var jt = class {
  constructor(e11, t2, n2 = new wt(e11.network())) {
    __publicField(this, "provider");
    __publicField(this, "crypto");
    __publicField(this, "builder");
    __publicField(this, "state");
    __publicField(this, "prepared", false);
    __publicField(this, "feeMode", "none");
    this.provider = e11, this.crypto = n2, this.builder = L.new(e11.network()), this.state = {
      resource: t2,
      revealedInput: null,
      inputsToSpend: /* @__PURE__ */ new Map(),
      outputs: [],
      revealedOutputAmount: 0n,
      feeInput: null
    };
  }
  spendRevealedInput(e11, t2) {
    if (t2 <= 0n) throw new v(`spendRevealedInput amount must be > 0, got ${t2}`);
    let n2 = this.state.revealedInput;
    if (n2 !== null && n2.source !== e11) throw new v(`spendRevealedInput: all revealed input must come from one account (${n2.source} != ${e11})`);
    return this.state.revealedInput = {
      source: e11,
      amount: ((n2 == null ? void 0 : n2.amount) ?? 0n) + t2
    }, this;
  }
  toStealthOutput(e11) {
    return this.state.outputs.push(e11), this;
  }
  toRevealedOutput(e11) {
    if (e11 <= 0n) throw new v(`toRevealedOutput amount must be > 0, got ${e11}`);
    return this.state.revealedOutputAmount += e11, this;
  }
  payFeeFromRevealed(e11) {
    if (this.feeMode === "stealth") throw new v("payFeeFromRevealed: cannot combine with payFeeFromStealthInput \u2014 choose one fee path");
    if (this.state.revealedInput === null) throw new v("payFeeFromRevealed: call spendRevealedInput first to set the source account");
    if (e11 <= 0n) throw new v(`payFeeFromRevealed amount must be > 0, got ${e11}`);
    return this.feeMode = "revealed", this.builder.feeTransactionPayFromComponent(this.state.revealedInput.source, e11), this;
  }
  payFeeFromStealthInput(e11, t2, n2) {
    if (this.feeMode === "revealed") throw new v("payFeeFromStealthInput: cannot combine with payFeeFromRevealed \u2014 choose one fee path");
    if (this.feeMode === "stealth") throw new v("payFeeFromStealthInput: fee input already set \u2014 call this once only");
    if (n2 <= 0n) throw new v(`payFeeFromStealthInput: maxFee must be > 0, got ${n2}`);
    let r2 = new q(t2);
    return this.state.feeInput = {
      owner: e11,
      input: r2,
      feeAmount: n2
    }, this.feeMode = "stealth", this;
  }
  withBuilder(e11) {
    return this.builder = e11(this.builder), this;
  }
  spendStealthInput(e11, t2) {
    let n2 = new q(t2), r2 = b(n2.commitment), i2 = this.state.inputsToSpend.get(r2);
    if (i2 !== void 0) throw new v(`spendStealthInput: duplicate commitment ${r2} \u2014 each commitment is one UTXO and may be spent once (already added for owner ${i2.owner}). A commitment uniquely identifies a UTXO; adding it again (even under a different owner) would self-double-spend.`);
    return this.state.inputsToSpend.set(r2, {
      input: n2,
      owner: e11
    }), this;
  }
  async prepare() {
    var _a;
    if (this.prepared) throw new v("StealthTransfer.prepare: already prepared \u2014 create a new StealthTransfer to build again");
    this.validate(), this.prepared = true;
    let { statement: e11, outputMask: t2 } = await this.crypto.generateOutputsStatement(this.state.outputs, this.state.revealedOutputAmount), n2 = new Y(await this.crypto.buildInputsStatement([...this.state.inputsToSpend.values()].map((e12) => e12.input), ((_a = this.state.revealedInput) == null ? void 0 : _a.amount) ?? 0n), e11, void 0);
    this.emitInstructions(n2);
    let r2 = /* @__PURE__ */ new Set();
    if (this.state.revealedInput !== null) {
      let e12 = this.state.revealedInput.source;
      this.builder.addInput({
        substate_id: e12,
        version: null
      }), r2.add(e12);
      let t3 = await Ye(this.provider, e12);
      for (let e13 of t3) r2.has(e13) || (this.builder.addInput({
        substate_id: e13,
        version: null
      }), r2.add(e13));
    }
    for (let { input: e12 } of this.state.inputsToSpend.values()) {
      let t3 = X(this.state.resource, e12.commitment);
      r2.has(t3) || (this.builder.addInput({
        substate_id: t3,
        version: null
      }), r2.add(t3));
    }
    let i2;
    if (this.state.feeInput !== null) {
      let e12 = this.state.feeInput, t3 = await this.crypto.buildInputsStatement([e12.input], 0n), n3 = new Y(t3, new J('{"outputs":[],"revealed_output_amount":"0","agg_range_proof":""}'), void 0);
      this.emitFeeInstructions(n3);
      let a3 = X(this.state.resource, e12.input.commitment);
      r2.has(a3) || (this.builder.addInput({
        substate_id: a3,
        version: null
      }), r2.add(a3)), i2 = {
        input: e12.input,
        owner: e12.owner,
        feeAmount: e12.feeAmount,
        inputsStatement: t3
      };
    }
    let a2 = await U(this.provider, this.builder.buildUnsignedTransaction()), o2 = [...this.state.inputsToSpend.values()], s2 = this.collectRequiredSigners(o2);
    return {
      unsignedTx: a2,
      statement: n2,
      outputMask: t2,
      state: this.state,
      requiredSigners: s2,
      inputs: o2,
      feeSpec: i2
    };
  }
  collectRequiredSigners(e11) {
    let t2 = [], n2 = /* @__PURE__ */ new Set();
    this.state.revealedInput !== null && (t2.push(this.state.revealedInput.source), n2.add(this.state.revealedInput.source));
    for (let { owner: r2 } of e11) n2.has(r2) || (t2.push(r2), n2.add(r2));
    return this.state.feeInput !== null && !n2.has(this.state.feeInput.owner) && t2.push(this.state.feeInput.owner), t2;
  }
  validate() {
    var _a;
    let e11 = this.state.inputsToSpend.size > 0, t2 = ((_a = this.state.revealedInput) == null ? void 0 : _a.amount) ?? 0n;
    if (!(t2 > 0n || e11)) throw new v("StealthTransfer.prepare: no inputs \u2014 call spendRevealedInput or spendStealthInput first");
    if (this.state.outputs.length === 0 && this.state.revealedOutputAmount === 0n) throw new v("StealthTransfer.prepare: no outputs \u2014 call toStealthOutput or toRevealedOutput first");
    if (this.state.outputs.length === 0) throw new v("StealthTransfer.prepare: at least one stealth output is required");
    if (this.state.revealedOutputAmount > 0n && this.state.revealedInput === null) throw new v("StealthTransfer.prepare: revealed change requires a revealed source account to deposit into");
    if (!e11) {
      let e12 = this.state.outputs.reduce((e13, t3) => e13 + t3.amount, 0n), n2 = e12 + this.state.revealedOutputAmount, r2 = t2;
      if (r2 !== n2) throw new v(`StealthTransfer.prepare: unbalanced transfer \u2014 revealed input ${r2} != stealth out ${e12} + revealed out ${this.state.revealedOutputAmount} (= ${n2})`);
    }
  }
  emitInstructions(e11) {
    let t2 = this.state.revealedInput, n2 = null;
    t2 !== null && (this.builder.callMethod({
      componentAddress: t2.source,
      methodName: "withdraw"
    }, [A(this.state.resource), O(t2.amount)]).saveVar(rt), n2 = rt), this.builder.addInstruction(z({
      resourceAddress: this.state.resource,
      revealedInputBucket: n2,
      statement: e11
    }, (e12) => this.builder.resolveWorkspaceOffsetId(e12))), this.state.revealedOutputAmount > 0n && t2 !== null && this.builder.saveVar(it).callMethod({
      componentAddress: t2.source,
      methodName: "deposit"
    }, [{ Workspace: it }]);
  }
  emitFeeInstructions(e11) {
    this.builder.addFeeInstruction(z({
      resourceAddress: this.state.resource,
      revealedInputBucket: null,
      statement: e11
    }, () => ({
      id: 0,
      offset: null
    }))), this.builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } }), this.builder.addFeeInstruction({ PayFeeFromBucket: { bucket: {
      id: 0,
      offset: null
    } } });
  }
};
function Mt(e11) {
  if (Nt(e11) || e11.statementJson !== void 0) return e11.statementJson;
  if (e11.inputs.length > 0) throw new _("inputs statement has confidential inputs but no WASM statementJson \u2014 call buildInputsStatement first", { context: "statementJsonFor" });
  return JSON.stringify(e11.toJSON());
}
function Nt(e11) {
  return !("inputs" in e11);
}
async function Q(e11, t2, n2, r2, i2) {
  let a2 = Mt(r2), o2 = Mt(i2);
  return e11.generateBalanceProofSignature(t2, n2, a2, o2);
}
async function $(e11, t2, n2, r2) {
  let i2 = await e11.deriveAeadKey(r2.viewSecret, r2.senderPublicNonce);
  return e11.unblindOutput(t2, n2, i2, r2.skipMemo);
}
async function Pt(e11, t2, n2, r2) {
  let i2 = Z(n2, r2);
  if (i2 === null) return null;
  let a2 = x(i2.body.encrypted_data), o2 = x(i2.body.public_nonce);
  try {
    return await $(e11, i2.commitment, a2, {
      senderPublicNonce: o2,
      viewSecret: t2,
      skipMemo: false
    });
  } catch {
    return null;
  }
}
async function Ft(e11, t2, n2) {
  if (t2.length === 0) throw new v("generateOutputsStatement: at least one stealth output is required");
  let { statement: r2, outputMask: i2 } = await e11.generateOutputsStatement(t2, n2), a2 = await e11.buildInputsStatement([], 0n);
  return new Y(a2, r2, await Q(e11, K.zero(), i2, a2, r2));
}
var It = class e10 {
  constructor(e11, t2, n2, r2, i2) {
    this.wallet = e11, this.spec = t2, this.crypto = n2, this.mustSignWithAccountKey = r2, this.viewSecret = i2;
  }
  static fromSpec(t2, n2, r2 = {}) {
    return new e10(t2, n2, r2.crypto ?? new wt(), r2.mustSignWithAccountKey ?? true, r2.viewSecret);
  }
  async prepare(e11) {
    let t2 = await this.resolveStealthInputs(e11), n2 = t2.length === 0 ? K.zero() : await this.crypto.aggregateInputMasks(t2.map((e12) => e12.mask)), r2 = await Q(this.crypto, n2, this.spec.outputMask, this.spec.statement.inputsStatement, this.spec.statement.outputsStatement), i2 = new Y(this.spec.statement.inputsStatement, this.spec.statement.outputsStatement, r2);
    await this.crypto.validateTransfer(i2);
    let a2 = Rt(this.spec.unsignedTx, i2), o2 = t2;
    if (this.spec.feeSpec !== void 0) {
      let n3 = this.spec.feeSpec, { feeResolvedInput: r3, feeValue: i3 } = await this.resolveFeeInput(e11, n3);
      if (i3 <= n3.feeAmount) throw new v(`WalletStealthAuthorizer: fee UTXO value (${i3}) must exceed maxFee (${n3.feeAmount}) \u2014 not enough balance to cover the fee. Use a UTXO with a higher balance.`);
      let s3 = i3 - n3.feeAmount, { statement: c2, outputMask: l2 } = await this.crypto.generateOutputsStatement([vt({
        destination: n3.owner,
        amount: s3,
        resourceAddress: this.spec.state.resource
      })], n3.feeAmount), u2 = await Q(this.crypto, r3.mask, l2, n3.inputsStatement, c2), ee2 = new Y(n3.inputsStatement, c2, u2);
      a2 = zt(a2, ee2), o2 = [...t2, r3];
    }
    let s2 = {
      ...this.spec,
      unsignedTx: a2,
      statement: i2
    };
    return new Lt({
      wallet: this.wallet,
      crypto: this.crypto,
      spec: s2,
      resolvedInputs: o2,
      mustSignWithAccountKey: this.mustSignWithAccountKey,
      sealKeypair: at()
    });
  }
  async resolveViewSecret() {
    if (this.viewSecret !== void 0) return this.viewSecret;
    let e11 = this.wallet.getKeyProvider(await this.safeDefaultAddress());
    if ((e11 == null ? void 0 : e11.getViewSecret) !== void 0) try {
      return await e11.getViewSecret();
    } catch (e12) {
      throw e12 instanceof p ? e12 : new p("WalletStealthAuthorizer: spending stealth inputs needs a view secret to unblind them, but the wallet's default signer could not provide one. Pass `fromSpec(wallet, spec, { viewSecret })` or use a SecretKeyWallet (created with a view key) as the default signer.", { cause: e12 });
    }
    throw new p("WalletStealthAuthorizer: spending stealth inputs needs a view secret to unblind them, but none was supplied and the wallet's default signer cannot provide one. Pass `fromSpec(wallet, spec, { viewSecret })` or use a SecretKeyWallet (created with a view key) as the default signer.");
  }
  async safeDefaultAddress() {
    try {
      return await this.wallet.getAddress();
    } catch {
      return "";
    }
  }
  async resolveStealthInputs(e11) {
    if (this.spec.inputs.length === 0) return [];
    let t2 = await this.resolveViewSecret(), n2 = this.spec.state.resource, r2 = await Promise.allSettled(this.spec.inputs.map(async ({ input: r3, owner: i3 }) => {
      let a2 = b(r3.commitment), o2 = await e11.getStealthUtxo(n2, r3.commitment);
      if (o2 === null) throw new p(`WalletStealthAuthorizer.prepare: stealth input UTXO not found (spent or never created) for ${a2}`);
      let s2 = Z(o2, X(n2, r3.commitment));
      if (s2 === null) throw new p(`WalletStealthAuthorizer.prepare: stealth input ${a2} is not a live, spendable UTXO`);
      let c2 = x(s2.body.public_nonce), l2;
      try {
        l2 = await $(this.crypto, s2.commitment, x(s2.body.encrypted_data), {
          senderPublicNonce: c2,
          viewSecret: t2,
          skipMemo: true
        });
      } catch (e12) {
        throw new _(`WalletStealthAuthorizer.prepare: failed to decrypt stealth input with commitment ${b(r3.commitment)} (owner ${i3}). This usually means the supplied view secret does not own this UTXO. Pass the correct \`viewSecret\` via \`fromSpec(wallet, spec, { viewSecret })\`, or use the owning SecretKeyWallet (with its view key) as the default signer. Note: a single view secret is resolved for all inputs \u2014 spending UTXOs owned by distinct view keys in one transfer is not supported.`, {
          cause: e12,
          context: "unblindOutput"
        });
      }
      return {
        ownerAddr: i3,
        input: r3,
        mask: l2.mask,
        publicNonce: c2
      };
    })), i2 = r2.find((e12) => e12.status === "rejected");
    if (i2 !== void 0) throw i2.reason;
    return r2.map((e12) => e12.value);
  }
  async resolveFeeInput(e11, t2) {
    let n2 = await this.resolveViewSecret(), r2 = this.spec.state.resource, { input: i2, owner: a2 } = t2, o2 = b(i2.commitment), s2 = await e11.getStealthUtxo(r2, i2.commitment);
    if (s2 === null) throw new p(`WalletStealthAuthorizer.prepare: fee UTXO not found (spent or never created) for ${o2}`);
    let c2 = Z(s2, X(r2, i2.commitment));
    if (c2 === null) throw new p(`WalletStealthAuthorizer.prepare: fee UTXO ${o2} is not a live, spendable UTXO`);
    let l2 = x(c2.body.public_nonce), u2;
    try {
      u2 = await $(this.crypto, c2.commitment, x(c2.body.encrypted_data), {
        senderPublicNonce: l2,
        viewSecret: n2,
        skipMemo: true
      });
    } catch (e12) {
      throw new _(`WalletStealthAuthorizer.prepare: failed to decrypt fee UTXO with commitment ${o2} (owner ${a2}). The supplied view secret does not own this UTXO. Pass the correct viewSecret via fromSpec(wallet, spec, { viewSecret }).`, {
        cause: e12,
        context: "unblindOutput"
      });
    }
    return {
      feeResolvedInput: {
        ownerAddr: a2,
        input: i2,
        mask: u2.mask,
        publicNonce: l2
      },
      feeValue: u2.value
    };
  }
}, Lt = class {
  constructor(e11) {
    __publicField(this, "wallet");
    __publicField(this, "crypto");
    __publicField(this, "spec");
    __publicField(this, "resolvedInputs");
    __publicField(this, "mustSignWithAccountKey");
    __publicField(this, "sealKeypair");
    __publicField(this, "extraSignatures", []);
    __publicField(this, "cachedAuthorizations");
    this.wallet = e11.wallet, this.crypto = e11.crypto, this.spec = e11.spec, this.resolvedInputs = e11.resolvedInputs, this.mustSignWithAccountKey = e11.mustSignWithAccountKey, this.sealKeypair = e11.sealKeypair;
  }
  getSealPublicKey() {
    return this.sealKeypair.public_key;
  }
  getSpec() {
    return this.spec;
  }
  async createAuthorizations() {
    return this.cachedAuthorizations === void 0 && (this.cachedAuthorizations = await this.computeAuthorizations()), this.cachedAuthorizations;
  }
  async computeAuthorizations() {
    if (this.resolvedInputs.length === 0) return [];
    let e11 = H(this.spec.unsignedTx), t2 = this.sealKeypair.public_key, n2 = [];
    for (let r2 of this.resolvedInputs) {
      let i2 = this.wallet.getKeyProvider(r2.ownerAddr);
      if (i2 === void 0) throw new m(`AuthorizedTransfer.createAuthorizations: no signer registered for stealth-input owner ${r2.ownerAddr}. Register it via wallet.registerKeyProvider(owner, signer).`, { address: r2.ownerAddr });
      if (i2.addStealthSignature === void 0) throw new g(`AuthorizedTransfer.createAuthorizations: signer for ${r2.ownerAddr} cannot produce one-time stealth signatures. Use a SecretKeyWallet (which holds the owner secret).`);
      let a2 = await i2.addStealthSignature(e11, r2.publicNonce, t2, { crypto: this.crypto });
      n2.push({
        signerAddress: r2.ownerAddr,
        signatures: [a2]
      });
    }
    return n2;
  }
  addSignature(e11) {
    return this.extraSignatures.push(e11), this;
  }
  async seal() {
    let e11 = (await this.createAuthorizations()).flatMap((e12) => e12.signatures), t2 = [];
    this.mustSignWithAccountKey && t2.push(this.wallet);
    let n2 = [...e11, ...this.extraSignatures];
    return n2.length > 0 && t2.push(new Bt(n2)), G(await W(t2, this.spec.unsignedTx, this.sealKeypair));
  }
};
function Rt(e11, t2) {
  let n2 = e11.instructions.findIndex(V);
  if (n2 < 0) throw new v("patchStealthStatement: expected exactly one StealthTransfer instruction, found 0 (not a stealth tx)");
  if (e11.instructions.slice(n2 + 1).findIndex(V) >= 0) throw new v("patchStealthStatement: expected exactly one StealthTransfer instruction, found more than one (malformed)");
  let r2 = { StealthTransfer: {
    ...e11.instructions[n2].StealthTransfer,
    statement: B(t2)
  } }, i2 = [...e11.instructions];
  return i2[n2] = r2, {
    ...e11,
    instructions: i2
  };
}
function zt(e11, t2) {
  let n2 = e11.fee_instructions.findIndex(V);
  if (n2 < 0) throw new v("patchFeeStealthStatement: expected exactly one StealthTransfer in fee_instructions, found 0");
  if (e11.fee_instructions.slice(n2 + 1).findIndex(V) >= 0) throw new v("patchFeeStealthStatement: expected exactly one StealthTransfer in fee_instructions, found more than one");
  let r2 = { StealthTransfer: {
    ...e11.fee_instructions[n2].StealthTransfer,
    statement: B(t2)
  } }, i2 = [...e11.fee_instructions];
  return i2[n2] = r2, {
    ...e11,
    fee_instructions: i2
  };
}
var Bt = class {
  constructor(e11) {
    this.signatures = e11;
  }
  async getAddress() {
    throw new g("StaticSignatureSigner has no address");
  }
  async getPublicKey() {
    throw new g("StaticSignatureSigner has no public key");
  }
  async signTransaction(e11, t2) {
    return this.signatures;
  }
};
export {
  ft as AccountInvokeBuilder,
  Lt as AuthorizedTransfer,
  xt as BalanceProofSignature,
  _ as CryptoBridgeError,
  h as DefaultSignerNotSetError,
  gt as EncryptedData,
  pt as FaucetInvokeBuilder,
  re as IndexerClientError,
  v as InvalidArgumentError,
  m as KeyProviderNotFoundError,
  K as Mask,
  d as Network,
  f as OotleError,
  mt as OotleWallet,
  oe as OperationCancelledError,
  g as SignerError,
  q as StealthInput,
  St as StealthInputsStatement,
  J as StealthOutputsStatement,
  jt as StealthTransfer,
  Y as StealthTransferStatement,
  Qe as TARI_RESOURCE_ADDRESS,
  L as TransactionBuilder,
  ie as TransactionRejectedError,
  ae as TransactionTimeoutError,
  p as WalletError,
  It as WalletStealthAuthorizer,
  wt as WasmStealthCrypto,
  tt as XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  $e as XTR_FAUCET_COMPONENT_ADDRESS,
  et as XTR_FAUCET_VAULT_ADDRESS,
  O as amountLiteral,
  y as assertByteLength,
  se as assertUnreachable,
  Ee as boolLiteral,
  ot as buildTransactionSignature,
  k as bytesLiteral,
  je as claimedOutputTombstoneAddressLiteral,
  ct as classifyOutcome,
  At as commitmentOf,
  De as componentAddressLiteral,
  vt as createOutput,
  $ as decryptInputData,
  Pt as decryptOwnedUtxo,
  Ge as defaultIndexerUrl,
  x as fromHexStr,
  Ft as generateOutputsStatement,
  at as generateSealKeypair,
  Ye as getVaultIdsForAccount,
  we as intLiteral,
  V as isStealthTransferInstruction,
  Je as iterVaultIdsInState,
  Ce as literalArg,
  Oe as metadataLiteral,
  I as microTariLiteral,
  Be as microTariString,
  Pe as nonFungibleAddressLiteral,
  Z as parseSubstateUtxo,
  Ve as parseWorkspaceStringKey,
  zt as patchFeeStealthStatement,
  Rt as patchStealthStatement,
  Ne as publicKeyLiteral,
  U as resolveTransaction,
  A as resourceAddressLiteral,
  G as sealTransaction,
  dt as sendDryRun,
  ut as sendTransaction,
  H as serializeUnsignedTx,
  Q as signBalanceProof,
  W as signTransaction,
  B as statementAsWire,
  z as stealthTransferInstruction,
  X as stealthUtxoSubstateId,
  Te as stringLiteral,
  st as submitTransaction,
  Ae as templateAddressLiteral,
  b as toHexStr,
  Fe as utxoAddressLiteral,
  Me as validatorFeePoolAddressLiteral,
  ke as vaultIdLiteral,
  lt as watchTransaction
};
