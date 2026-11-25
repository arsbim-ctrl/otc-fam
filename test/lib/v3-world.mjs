// The broker-deal world (scripts/lib/world3.mjs) as the tests need it: the same tokens as the version 2 tests
// (test/lib/v2-world.mjs): EdgeTokens, whose behaviour a test can change, or one of the checks' tokens when a test
// names its contract (PlainToken, NoReturnToken, ReentrantToken, round 2's FixtureToken). It also says which error a
// refused call reverted with, for BrokerDeals and its vaults.
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { deploy, Reverted } from "../../.launchpad/checks/round-1/chain.mjs";
import { artifacts3, world3 } from "../../scripts/lib/world3.mjs";
import { artifacts as v2Artifacts, KIND, PEOPLE } from "./v2-world.mjs";

export { ALLOCATION, DAY, feeOn, feesOf, QUOTE, SIGNERS, STATUS3, TYPES, WHO, ZERO } from "../../scripts/lib/world3.mjs";
export { KIND, PEOPLE } from "./v2-world.mjs";

let compiled;
/** The stand's contracts and tokens with BrokerDeals, and the tests' own tokens: EdgeToken, and round 2's FixtureToken. */
export function artifacts() {
  compiled ??= { ...v2Artifacts(), ...artifacts3() };
  return compiled;
}

let known;
/** Every error BrokerDeals and its vaults can revert with, by its data: their own, and those of TokenMoves. */
export const errors = () => (known ??= new Interface([...artifacts().BrokerDeals.abi, ...artifacts().GrantVault.abi].filter((f) => f.type === "error")));

/**
 * The error `sending` reverts with, `{ name, args }`; fails if it goes through. `sending` is a transaction, a
 * deployment, or a read (a view reverts too). A revert that names no error of the contracts is given as it came.
 */
export async function reverted(sending) {
  try {
    await sending;
  } catch (e) {
    const data = /return data: (0x[0-9a-f]+)/.exec(e.message)?.[1];
    if (!(e instanceof Reverted) && !data) throw e;
    const error = data ? errors().parseError(data) : null;
    return error ? { name: error.name, args: error.args.toArray() } : { name: data ?? e.message, args: [] };
  }
  assert.fail("the call went through: it must revert");
}

/** The name of the error `sending` reverts with; fails if it goes through. */
export const revertsWith = async (sending) => (await reverted(sending)).name;

/** A token for a test: an EdgeToken of `kind` (Plain unless named), or the contract `kind` names. */
function makeToken(chain, symbol, decimals, kind = "Plain") {
  const a = artifacts();
  return kind in KIND ? deploy(chain, PEOPLE.deployer, a.EdgeToken, [symbol, decimals, KIND[kind]], { label: symbol })
    : deploy(chain, PEOPLE.deployer, a[kind], [symbol, decimals], { label: symbol });
}

/** A fresh world with broker deals for one test, with the tests' tokens. */
export const world = () => world3({ makeToken });
