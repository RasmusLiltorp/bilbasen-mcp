import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";

const requireFromHere = createRequire(import.meta.url);
import { pageCache } from "./cache.ts";
import { FETCH_TIMEOUT_MS, USER_AGENT } from "./constants.ts";

let chromiumInstalled = false;
let installInFlight: Promise<void> | null = null;

/**
 * Playwright ships without browsers; on a packaged `.mcpb` install the user
 * has never run `playwright install`. Trigger it lazily on first use so the
 * server works out-of-the-box. Subsequent launches are zero-cost.
 */
async function ensureChromium(): Promise<void> {
  if (chromiumInstalled) return;
  if (!installInFlight) {
    installInFlight = new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [requireFromHere.resolve("playwright/cli"), "install", "chromium"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`playwright install chromium exited with code ${code}`)),
      );
    }).then(() => {
      chromiumInstalled = true;
    });
  }
  await installInFlight;
}

/**
 * Bilbasen is protected by an AWS WAF JavaScript challenge. A headless browser
 * is used ONCE to solve that challenge and harvest the `aws-waf-token` cookie;
 * after that, every page is retrieved with a plain `fetch` carrying the cookie,
 * which is dramatically faster than driving a browser per request. The browser
 * is only relaunched if the token goes stale.
 */

export class BilbasenBlockedError extends Error {}

let cookieHeader = "";
let solveInFlight: Promise<void> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A response that still contains the AWS WAF challenge bootstrap is not real content. */
function isChallenge(body: string): boolean {
  return body.includes("awsWafCookieDomainList") || body.includes("/.well-known/captcha/");
}

/**
 * Launches headless Chromium, solves the WAF challenge by navigating to a real
 * page, and stores the resulting cookies. Heavy assets are blocked for speed.
 */
async function solveWafChallenge(triggerUrl: string): Promise<void> {
  await ensureChromium();
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "da-DK",
      viewport: { width: 1280, height: 900 },
    });
    await ctx.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
        return route.abort();
      }
      return route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(triggerUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // The challenge auto-reloads into the real page once solved.
    await page.waitForFunction(
      () =>
        document.getElementById("__NEXT_DATA__") !== null ||
        document.querySelector('[data-e2e="car-make-model-variant"]') !== null,
      undefined,
      { timeout: 30000 },
    );
    const cookies = await ctx.cookies();
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await browser.close();
  }
}

/** Ensures a WAF token exists, coalescing concurrent callers into one solve. */
async function ensureToken(triggerUrl: string): Promise<void> {
  if (!solveInFlight) {
    solveInFlight = solveWafChallenge(triggerUrl).finally(() => {
      solveInFlight = null;
    });
  }
  await solveInFlight;
}

async function rawFetch(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Returns the HTML of a Bilbasen URL. Served from cache when fresh; otherwise
 * fetched directly, transparently (re)solving the WAF challenge as needed.
 */
export async function fetchHtml(url: string): Promise<string> {
  const cached = pageCache.get(url);
  if (cached !== undefined) return cached;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!cookieHeader) {
      try {
        await ensureToken(url);
      } catch (error) {
        lastError = error;
      }
    }

    if (cookieHeader) {
      try {
        const { status, body } = await rawFetch(url);
        if (status === 200 && !isChallenge(body)) {
          pageCache.set(url, body);
          return body;
        }
        // Token rejected or stale — drop it so the next attempt re-solves.
        cookieHeader = "";
        lastError = new BilbasenBlockedError(`Bilbasen returned status ${status} for ${url}.`);
      } catch (error) {
        lastError = error;
      }
    }

    if (attempt < 3) await sleep(500 * attempt);
  }

  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new BilbasenBlockedError(
    `Could not load ${url} after 3 attempts${detail}. Bilbasen's anti-bot protection may be blocking requests; try again shortly.`,
  );
}
