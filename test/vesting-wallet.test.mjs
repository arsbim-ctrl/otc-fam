import assert from "node:assert/strict";
import { test } from "node:test";
import { id, zeroPadValue, toBeHex } from "ethers";
import { broadcast, Wallet } from "../web/eth.js";
import { spendingStep } from "../web/vesting.js";
import { rememberFunding, fundingReceipt } from "../web/funding-receipt.js";

const owner = "0x" + "11".repeat(20), contract = "0x" + "22".repeat(20);
const token = { address: "0x" + "33".repeat(20), decimals: 0, symbol: "BASE" };
const config = { contract, chainId: 31337 };
const hash = "0x" + "aa".repeat(32);
const stage = () => {};

function spending(initial, requiresReset = false) {
  let allowance = initial;
  const approvals = [];
  const app = { config, wallet: { account: owner, async send({ data }) {
    allowance = BigInt("0x" + data.slice(-64));
    approvals.push(allowance);
    return hash;
  } }, chain: {
    balanceOf: async () => 1000n, allowance: async () => allowance,
    async call(_to, data) {
      if (requiresReset && allowance && BigInt("0x" + data.slice(-64))) throw new Error("execution reverted: reset first");
      return "0x" + "0".repeat(63) + "1";
    },
    receipt: async () => ({ status: "0x1" }),
  } };
  return { step: units => spendingStep(app, token, units, owner), approvals };
}

test("a shared allowance is reused; a stale approval action cannot reduce a sufficient allowance", async () => {
  const { step, approvals } = spending(10n);
  const small = await step(30n), large = await step(90n);
  assert.equal(large.kind, "approve"); // direct change permitted on this ERC-20
  // Both tabs press their old buttons before either approval is mined.
  await Promise.all([large.run(stage), small.run(stage)]);
  assert.equal((await step(30n)).kind, "ready");
  assert.deepEqual(approvals, [90n]);
  assert.equal((await spending((1n << 256n) - 1n).step(30n)).kind, "ready");
});

test("two reviewed resets and approvals for a reset-required token share one reset and one approval", async () => {
  const { step, approvals } = spending(10n, true);
  const small = await step(30n), large = await step(90n);
  assert.equal(small.kind, "reset");
  await small.run(stage);
  await large.run(stage); // should not sign a positive approval from a reset button
  const readyToApprove = await step(90n);
  assert.equal(readyToApprove.kind, "approve");
  await readyToApprove.run(stage);
  await small.run(stage); // stale reset must leave the 90-unit allowance intact
  assert.deepEqual(approvals, [0n, 90n]);
});

function signer() {
  let network = "0x7a69", account = owner, duringAccounts;
  const events = new Map(), sent = [];
  const wallet = new Wallet({
    on: (name, handler) => events.set(name, handler),
    async request({ method, params }) {
      if (method === "eth_accounts") { duringAccounts?.(); return [account]; }
      if (method === "eth_chainId") return network;
      if (method === "eth_sendTransaction") { sent.push(params[0]); return hash; }
      throw Error(method);
    },
  }, stage);
  return { wallet, sent,
    switchNetwork: () => { network = "0x1"; events.get("chainChanged")(network); },
    switchAccount: () => { account = contract; events.get("accountsChanged")([account]); },
    onAccounts: fn => { duringAccounts = fn; },
  };
}

test("signing pins from and chainId and refuses signer changes during preflight and final validation", async () => {
  for (const when of ["during simulation", "during account read", "stable"]) {
    const s = signer();
    await s.wallet.ready;
    const app = { config, wallet: s.wallet, chain: { async call() {
      if (when === "during simulation") s.switchAccount();
      if (when === "during account read") s.onAccounts(s.switchNetwork);
      return "0x";
    } } };
    const send = broadcast(app, contract, "0x12345678", stage, "Funding", owner);
    if (when === "stable") {
      assert.equal(await send, hash);
      assert.deepEqual(s.sent, [{ to: contract, data: "0x12345678", from: owner, chainId: "0x7a69" }]);
    } else {
      await assert.rejects(send, /wallet changed/i);
      assert.equal(s.sent.length, 0);
    }
  }
});

test("broadcast funding hashes survive a new page and failed polling, scoped by signer and deployment", async t => {
  const items = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: (k, v) => items.set(k, v), key: i => [...items.keys()][i], get length() { return items.size; },
  } });
  t.after(() => { delete globalThis.localStorage; });
  const second = "0x" + "bb".repeat(32);
  rememberFunding(config, owner, hash);
  rememberFunding(config, owner, second);
  const fresh = await import("../web/funding-receipt.js?fresh");
  assert.deepEqual(fresh.fundingHistory(config, owner), [hash, second]);
  assert.deepEqual(fresh.fundingHistory(config, contract), []);
  assert.deepEqual(fresh.fundingHistory({ ...config, chainId: 1 }, owner), []);
  const chain = { contract, rpc: async () => { throw Error("RPC offline"); } };
  await assert.rejects(fundingReceipt(chain, hash), /RPC offline/);
  chain.rpc = async () => null;
  assert.deepEqual(await fundingReceipt(chain, hash), { state: "Pending" });
  const receipt = { to: contract, transactionHash: hash, status: "0x1", logs: [
    { address: contract, topics: [id("DealFunded(uint256,address,address)"), zeroPadValue(toBeHex(7), 32)] },
  ] };
  chain.rpc = async () => receipt;
  assert.deepEqual(await fundingReceipt(chain, hash), { state: "Funded", id: 7n });
  await assert.rejects(fundingReceipt(chain, second), /does not match/);
  receipt.status = "0x0";
  assert.deepEqual(await fundingReceipt(chain, hash), { state: "Failed" });
});
