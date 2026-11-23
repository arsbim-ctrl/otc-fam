// The stand's world (scripts/lib/world.mjs) as the tests need it: its tokens are EdgeTokens, whose behaviour a test
// can change (a fee from the amount, on top of it, on transfer only, an answer of false), or one of the checks'
// tokens when a test names its contract (NoReturnToken, ReentrantToken, round 2's FixtureToken). It also says which
// error a refused call reverted with.
import assert from "node:assert/strict";
import { join } from "node:path";
import { Interface } from "ethers";
import { deploy, Reverted } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { artifacts as standArtifacts, PEOPLE, world as standWorld } from "../../scripts/lib/world.mjs";

export { ALLOCATION, DAY, feeOn, PEOPLE, QUOTE, STATUS, ZERO } from "../../scripts/lib/world.mjs";
export const KIND = { Plain: 0, Fee: 1, FeeOnTop: 2, False: 3, Reset: 4, TransferFee: 5 }; // EdgeToken.Kind

let compiled;
/** The stand's contracts and tokens, with the tests' own: EdgeToken, and round 2's FixtureToken. */
export function artifacts() {
  compiled ??= { ...standArtifacts(), ...compile(ROOT, "test/tokens/EdgeToken.sol"), ...compile(join(ROOT, ".launchpad/checks"), "round-2/FixtureToken.sol") };
  return compiled;
}

/** Every error the v2 contracts can revert with, by its data. */
export const errors = () => new Interface([...artifacts().OtcDealsV2.abi, ...artifacts().GrantVault.abi].filter((f) => f.type === "error"));

/** The name of the error `sending` reverts with; fails if it goes through. */
export async function revertsWith(sending) {
  try {
    await sending;
  } catch (e) {
    if (!(e instanceof Reverted)) throw e;
    const data = /return data: (0x[0-9a-f]+)/.exec(e.message)?.[1];
    return data ? errors().parseError(data)?.name ?? data : e.message;
  }
  assert.fail("the call went through: it must revert");
}

/** A token for a test: an EdgeToken of `kind` (Plain unless named), or the contract `kind` names. */
function makeToken(chain, symbol, decimals, kind = "Plain") {
  const a = artifacts();
  return kind in KIND ? deploy(chain, PEOPLE.deployer, a.EdgeToken, [symbol, decimals, KIND[kind]], { label: symbol })
    : deploy(chain, PEOPLE.deployer, a[kind], [symbol, decimals], { label: symbol });
}

/** A fresh world for one test, with the tests' tokens. */
export const world = () => standWorld({ makeToken });
