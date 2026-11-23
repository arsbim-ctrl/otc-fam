// Fresh phone-width browser contexts for each role. The shared chain has only fixture tokens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_ID, deploy, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { serve, wallet, withPage } from "../.launchpad/checks/round-1/page.mjs";

test("a seller funds, a buyer settles and a returning beneficiary claims from fresh links", async () => {
  const [issuer, seller, buyer, treasury] = ["11", "22", "33", "44"].map(pair => "0x" + pair.repeat(20));
  const chain = await startChain([issuer, seller, buyer]);
  const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
  const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
  const deals = await deploy(chain, issuer, OtcDealsV2, [treasury]);
  const base = await deploy(chain, issuer, EdgeToken, ["BASE", 0, 4]);
  const payment = await deploy(chain, issuer, EdgeToken, ["USD", 6, 4]);
  await base.as(issuer).mint(seller, 300n);
  await payment.as(issuer).mint(buyer, 201_009_999n);
  await payment.as(buyer).approve(deals.address, 1n);
  const site = await serve({ chain, deals });
  const config = { contractV2: deals.address, contract: "0x" + "0".repeat(40), chainId: CHAIN_ID, rpcUrl: "/rpc" };
  const fresh = (hash, account, check, wrongNetwork = false) => {
    const requests = wallet({ chain }, account);
    const answer = async request => {
      if (wrongNetwork && request.method === "eth_chainId") return { result: "0x1" };
      if (request.method === "wallet_switchEthereumChain") wrongNetwork = false;
      return requests(request);
    };
    return withPage(site, "#/", account && answer, async page => {
      await page.route("**/config.json", route => route.fulfill({ json: config }));
      await page.goto(site.url + "/?funded" + hash);
      await check(page);
    });
  };
  const press = (p, label) => p.getByRole("button", { name: label, exact: true }).click();
  let dealLink, grantLink;
  try {
    await fresh("#/v2/new", seller, async p => {
      await press(p, "Connect wallet");
      await p.getByTestId("delivery").selectOption("position");
      await p.getByRole("button", { name: "Choose a supported delivery" }).waitFor();
      assert.ok(await p.getByRole("button", { name: "Choose a supported delivery" }).isDisabled());
      await p.getByTestId("delivery").selectOption("vesting");
      for (const [key, value] of Object.entries({
        baseToken: base.address, allocation: "300", quoteToken: payment.address, quote: "200.009999", buyer, cliff: "1", duration: "3",
      })) await p.getByTestId(key).fill(value);
      await press(p, "Review terms and fees");
      assert.equal(await p.getByTestId("pay-amount").textContent(), "201.010048");
      await press(p, "Approve 300 BASE");
      // Lose the receipt lookup after broadcast. Recover after leaving the
      // page and reloading with a fresh JS heap, without another signature.
      await p.route("**/rpc", route => route.request().postDataJSON().method === "eth_getTransactionReceipt"
        ? route.abort() : route.continue());
      await press(p, "Fund deal with 300 BASE");
      const recovery = await p.getByTestId("recovery-link").getAttribute("href");
      assert.match(recovery, /#\/v2\/tx\/0x[0-9a-f]{64}$/i);
      await p.goto(site.url + "/?funded#/v2/new");
      await p.reload();
      await p.unroute("**/rpc");
      await p.getByRole("link", { name: /^Funding transaction/ }).click();
      assert.equal(p.url(), recovery);
      dealLink = new URL(await p.getByTestId("deal-link").getAttribute("href")).hash;
    });
    await fresh(dealLink, null, async p => {
      assert.equal(await p.getByTestId("pay-amount").textContent(), "201.010048");
      assert.equal(await p.getByTestId("receive-amount").textContent(), "300");
      assert.ok(await p.getByRole("button", { name: "Wallet required" }).isDisabled());
    });
    await fresh(dealLink, buyer, async p => {
      await press(p, "Connect wallet");
      await press(p, "Switch to Local test chain");
      await p.getByRole("button", { name: "Insufficient USD" }).waitFor();
      await payment.as(issuer).mint(buyer, 49n);
      await p.reload();
      await press(p, "Reset existing allowance to zero");
      await press(p, "Approve 201.010048 USD");
      await press(p, "Settle · pay 201.010048 USD");
      grantLink = new URL(await p.getByTestId("grant-link").getAttribute("href")).hash;
      assert.equal(await payment.read.allowance(buyer, deals.address), 0n);
    }, true);
    const grant = await deals.read.getGrant(1);
    await chain.setNextTime(Number(grant.end));
    await chain.mine();
    await fresh(grantLink, buyer, async p => {
      await press(p, "Connect wallet");
      await press(p, "Claim 300 BASE");
      await p.locator('[data-testid="deal-status"][data-status="claimed"]').waitFor();
      assert.equal(await base.read.balanceOf(buyer), 300n);
    });
    await fresh(grantLink, null, async p => {
      assert.equal(await p.getByTestId("deal-status").textContent(), "Claimed");
      assert.equal(await p.getByTestId("claimable-amount").textContent(), "0");
    });
  } finally { await site.close(); }
});
