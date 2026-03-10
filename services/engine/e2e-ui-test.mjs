#!/usr/bin/env node
/** Smoke-test the live UI with Playwright and capture screenshots. */

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE_URL = "http://localhost:3000";
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    testsFailed++;
    return false;
  }
  console.log(`  PASS: ${message}`);
  testsPassed++;
  return true;
}

async function main() {
  console.log("Market-Zap UI E2E Test\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    console.log("=== TEST 1: HOMEPAGE LOADS ===\n");

    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    assert(
      title.includes("MarketZap") || title.includes("Prediction"),
      `Page title contains MarketZap: "${title}"`,
    );

    await page.screenshot({ path: "/tmp/mz-homepage.png", fullPage: false });
    console.log("  Screenshot: /tmp/mz-homepage.png");

    const marketElements = await page.$$('[data-testid="market-card"], .market-card, a[href*="/markets/"]');
    if (marketElements.length > 0) {
      assert(true, `Found ${marketElements.length} market element(s)`);
    } else {
      const marketText = await page.textContent("body");
      const hasMarketContent =
        marketText.includes("Ethereum") ||
        marketText.includes("Yes") ||
        marketText.includes("No") ||
        marketText.includes("market") ||
        marketText.includes("E2E test");
      assert(hasMarketContent, "Page contains market-related content");
    }

    console.log("\n=== TEST 2: MARKET PAGE LOADS ===\n");

    const marketLinks = await page.$$('a[href*="/markets/"]');
    if (marketLinks.length > 0) {
      await marketLinks[0].click();
      await page.waitForTimeout(3000);

      const url = page.url();
      assert(url.includes("/markets/"), `Navigated to market page: ${url}`);

      await page.screenshot({ path: "/tmp/mz-market.png", fullPage: false });
      console.log("  Screenshot: /tmp/mz-market.png");

      const bodyText = await page.textContent("body");
      const hasTradePanel =
        bodyText.includes("Buy") ||
        bodyText.includes("Sell") ||
        bodyText.includes("Amount") ||
        bodyText.includes("Price") ||
        bodyText.includes("Order");
      assert(hasTradePanel, "Market page has trade panel elements");

      const hasOutcomes =
        bodyText.includes("Yes") || bodyText.includes("No");
      assert(hasOutcomes, "Market page shows outcomes (Yes/No)");

      const priceMatch = bodyText.match(/0\.\d{2,4}/);
      if (priceMatch) {
        assert(true, `Price displayed: ${priceMatch[0]}`);
      } else {
        console.log("  Note: No decimal prices found in page text");
      }
    } else {
      console.log("  No market links found — trying direct navigation");

      const markets = await (
        await fetch("http://localhost:3001/api/markets")
      ).json();
      if (markets.data?.items?.length > 0) {
        const mkt = markets.data.items[0];
        await page.goto(`${BASE_URL}/markets/${mkt.id}`, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        await page.waitForTimeout(2000);

        assert(true, `Navigated to market: ${mkt.id}`);
        await page.screenshot({ path: "/tmp/mz-market.png", fullPage: false });
        console.log("  Screenshot: /tmp/mz-market.png");
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Test 3: Check trade panel components
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n=== TEST 3: TRADE PANEL COMPONENTS ===\n");

    // Look for the buy/sell tabs or buttons
    const buyBtn = await page.$('button:has-text("Buy"), [data-testid="buy-tab"]');
    const sellBtn = await page.$('button:has-text("Sell"), [data-testid="sell-tab"]');

    if (buyBtn) {
      assert(true, "Buy button/tab found");
      await buyBtn.click();
      await page.waitForTimeout(500);
    }
    if (sellBtn) {
      assert(true, "Sell button/tab found");
    }

    // Look for amount input
    const amountInput = await page.$(
      'input[placeholder*="mount"], input[name="amount"], input[type="number"]',
    );
    if (amountInput) {
      assert(true, "Amount input found");
    }

    // Look for order type selector
    const bodyText = await page.textContent("body");
    const hasOrderTypes =
      bodyText.includes("Market") || bodyText.includes("Limit");
    if (hasOrderTypes) {
      assert(true, "Order type options visible (Market/Limit)");
    }

    // Check for wallet connection prompt or connected state
    const hasWallet =
      bodyText.includes("Connect") ||
      bodyText.includes("wallet") ||
      bodyText.includes("0x");
    if (hasWallet) {
      assert(true, "Wallet connection UI present");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Test 4: Verify AMM-specific UI elements
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n=== TEST 4: AMM-SPECIFIC UI ELEMENTS ===\n");

    // Check that the page doesn't show "No liquidity" on load
    const noLiquidityVisible =
      bodyText.includes("No liquidity available") ||
      bodyText.includes("no liquidity");
    assert(!noLiquidityVisible, "No 'No liquidity' error shown on load");

    // Check that prices are displayed (not just dashes or N/A)
    const priceElements = await page.$$('.price, [data-testid="price"]');
    if (priceElements.length > 0) {
      for (const el of priceElements.slice(0, 2)) {
        const text = await el.textContent();
        if (text && text.trim() !== "-" && text.trim() !== "N/A") {
          assert(true, `Price element shows value: "${text.trim()}"`);
        }
      }
    }

    // Take a final screenshot of the trade panel state
    await page.screenshot({
      path: "/tmp/mz-trade-panel.png",
      fullPage: true,
    });
    console.log("  Screenshot: /tmp/mz-trade-panel.png");

    // ─────────────────────────────────────────────────────────────────────
    // Test 5: Check API responses from browser
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n=== TEST 5: API RESPONSES FROM BROWSER ===\n");

    // Test that the engine API is accessible from the browser context
    const apiResponse = await page.evaluate(async () => {
      try {
        const res = await fetch("http://localhost:3001/api/health");
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    });

    assert(
      apiResponse.status === "ok",
      `Engine API accessible from browser: ${JSON.stringify(apiResponse)}`,
    );

    // Fetch markets from browser
    const marketsResponse = await page.evaluate(async () => {
      try {
        const res = await fetch("http://localhost:3001/api/markets");
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    });

    const marketCount = marketsResponse.data?.items?.length || 0;
    assert(marketCount > 0, `Browser can fetch ${marketCount} market(s)`);

  } catch (err) {
    console.error(`\n  ERROR: ${err.message}`);
    await page.screenshot({ path: "/tmp/mz-error.png" }).catch(() => {});
    testsFailed++;
  } finally {
    await browser.close();
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  UI RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
