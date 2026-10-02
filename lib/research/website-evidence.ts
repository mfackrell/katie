import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser, Page } from "playwright-core";
import type { ChatGenerateParams, WebsiteEvidence, WebsitePageEvidence } from "@/lib/providers/types";

const MAX_PAGES = 3;
const MAX_HTML = 12_000;
const MAX_CSS = 8_000;
const MAX_SCREENSHOT_BYTES = 900_000;
const VIEWPORTS = [
  { device: "desktop" as const, width: 1440, height: 900 },
  { device: "mobile" as const, width: 390, height: 844 },
];

function isWebsiteReview(params: ChatGenerateParams): boolean {
  const review = (params.requestIntent === "marketing-analysis" && websiteUrls(params.user).length > 0) ||
    /\b(review|audit|evaluate|critique|assess|inspect)\b[\s\S]{0,180}\b(website|site|landing page|design|aesthetic|https?:\/\/)/i.test(params.user) ||
    /\b(website|site|landing page)\b[\s\S]{0,100}\b(review|audit|critique|aesthetic|design)\b/i.test(params.user);
  return review;
}

function websiteUrls(message: string): string[] {
    const candidates = message.match(/https?:\/\/[^\s<>"\x60\[\]()]+|(?<![\w@/.-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"\x60\[\]()]*)?/gi) ?? [];
    const urls = candidates
      .map((url) => url.replace(/[),.;!?]+$/, ""))
      .map((url) => /^https?:\/\//i.test(url) ? url : "https://" + url)
      .filter((url) => {
        try {
          const parsed = new URL(url);
          return !parsed.username && !parsed.password &&
            !/\.(pdf|zip|csv|xlsx?|docx?|mp4|png|jpe?g|gif|webp)(?:$|\?)/i.test(parsed.pathname);
        } catch { return false; }
      });
    return [...new Set(urls)];
}

export function resolveWebsiteReviewTarget(params: ChatGenerateParams): { urls: string[]; source: "current-message" | "history" | "summary" | "none" } {
  if (!isWebsiteReview(params)) return { urls: [], source: "none" };
  const current = websiteUrls(params.user);
  if (current.length) return { urls: current.slice(0, MAX_PAGES), source: "current-message" };
  // Search the entire supplied conversational memory, not an arbitrary six entries.
  // User messages identify the target; assistant citations may link unrelated sites.
  for (const message of [...params.history].reverse().filter((entry) => entry.role === "user")) {
    const urls = websiteUrls(message.content);
    if (urls.length) return { urls: urls.slice(0, MAX_PAGES), source: "history" };
  }
  const summary = websiteUrls(params.summary);
  // A summary with several domains cannot unambiguously identify "the site".
  if (summary.length && new Set(summary.map((url) => new URL(url).hostname)).size === 1) {
    return { urls: summary.slice(0, MAX_PAGES), source: "summary" };
  }
  return { urls: [], source: "none" };
}

export function websiteReviewUrls(params: ChatGenerateParams): string[] {
  return resolveWebsiteReviewTarget(params).urls;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global unicast; exclude documentation, transition/tunnel and mapped ranges.
    const normalized = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(normalized) &&
      !/^(2001:(db8|0|2|10|20):|2002:)/.test(normalized);
  }
  return false;
}

export async function validateWebsiteUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    (url.port && !["80", "443"].includes(url.port))) {
    throw new Error("Website inspection only supports public HTTP(S) URLs without credentials.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error("Private website addresses are blocked.");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Website resolved to a non-public address.");
  }
}

export async function launchWebsiteBrowser(): Promise<Browser> {
  const [{ default: chromium }, { chromium: playwright }] = await Promise.all([
    import("@sparticuz/chromium"),
    import("playwright-core"),
  ]);
  return playwright.launch({
    args: chromium.args.filter((arg) => !["--single-process", "--disable-web-security", "--allow-running-insecure-content"].includes(arg)),
    executablePath: await chromium.executablePath(),
    headless: true,
    timeout: 15_000,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectView(page: Page, device: "desktop" | "mobile", viewport: { width: number; height: number }): Promise<WebsitePageEvidence["views"][number]> {
  const observed = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const nodes = Array.from(document.querySelectorAll("body, header, nav, main, section, footer, h1, h2, h3, p, a, button, input, form"));
    const important = nodes.filter((el) => visible(el) && !["P", "A"].includes(el.tagName));
    const supporting = nodes.filter((el) => visible(el) && ["P", "A"].includes(el.tagName));
    const properties = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color",
      "display", "position", "padding", "margin", "gap", "max-width", "grid-template-columns", "border-radius"];
    const elements = [...important, ...supporting].slice(0, 32).map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
        bounds: { x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)])),
      };
    });
    const images = Array.from(document.images).filter(visible).slice(0, 16).map((img) => ({
      src: img.currentSrc || img.src, alt: img.alt, loaded: img.complete && img.naturalWidth > 0,
      width: Math.round(img.getBoundingClientRect().width), height: Math.round(img.getBoundingClientRect().height),
    }));
    return {
      document: {
        width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      },
      text: (document.body?.innerText ?? "").slice(0, 10_000),
      elements, images,
    };
  });
  const limitations: string[] = [];
  let screenshot: WebsitePageEvidence["views"][number]["screenshot"];
  try {
    const height = Math.min(4500, observed.document.height);
    const buffer = await page.screenshot({
      type: "jpeg", quality: 65, animations: "disabled",
      clip: { x: 0, y: 0, width: viewport.width, height }, timeout: 8_000,
    });
    if (buffer.length <= MAX_SCREENSHOT_BYTES) {
      screenshot = { dataUrl: "data:image/jpeg;base64," + buffer.toString("base64"), width: viewport.width, height, truncated: height < observed.document.height };
      if (screenshot.truncated) limitations.push("Screenshot covers the first 4500 CSS pixels; lower content is not pictured.");
    } else {
      limitations.push("Screenshot exceeded the image byte limit; computed styles and DOM observations are available.");
    }
  } catch (error) { limitations.push("Screenshot failed: " + errorText(error)); }
  return { device, viewport, ...observed, ...(screenshot ? { screenshot } : {}), limitations };
}

export async function collectWebsiteEvidence(
  params: ChatGenerateParams,
  options: {
    timeoutMs?: number;
    launch?: () => Promise<Browser>;
    validate?: (url: string) => Promise<void>;
  } = {},
): Promise<WebsiteEvidence | undefined> {
  if (!isWebsiteReview(params)) return undefined;
  const { urls, source } = resolveWebsiteReviewTarget(params);
  const evidence: WebsiteEvidence = {
    capturedAt: new Date().toISOString(), pages: [],
    targetSource: source,
    limitations: ["Inspection samples up to three pages at desktop and mobile widths. Menus, forms, authentication and other interactive states are not exercised."],
  };
  if (!urls.length) {
    evidence.limitations.push("Rendered inspection skipped: no unambiguous website URL was found in the current message, full conversation history or summary. Ask for the target URL.");
    return evidence;
  }
  const validate = options.validate ?? validateWebsiteUrl;
  const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 45_000));
  let browser: Browser | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const launched = await (options.launch ?? launchWebsiteBrowser)();
    browser = launched;
    if (stopped) { await launched.close(); return; }
    const queue = [...urls];
    for (let index = 0; index < queue.length && index < MAX_PAGES && !stopped; index += 1) {
      const requestedUrl = queue[index];
      const result: WebsitePageEvidence = {
        requestedUrl, url: requestedUrl, title: "", html: "", htmlTruncated: false,
        stylesheets: [], views: [], limitations: [],
      };
      evidence.pages.push(result);
      try {
        await validate(requestedUrl);
        for (const viewport of VIEWPORTS) {
          if (stopped) break;
          const context = await launched.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.device === "mobile", hasTouch: viewport.device === "mobile",
            serviceWorkers: "block", acceptDownloads: false,
          });
          try {
            // Validate redirects and every subresource, including CSS and images.
            await context.route("**/*", async (route) => {
              try {
                if (!["GET", "HEAD"].includes(route.request().method())) { await route.abort(); return; }
                const raw = route.request().url();
                if (raw.startsWith("data:") || raw.startsWith("blob:")) { await route.continue(); return; }
                await validate(raw);
                if (stopped) await route.abort(); else await route.continue();
              } catch { await route.abort(); }
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            const page = await context.newPage();
            page.setDefaultTimeout(8_000);
            const cssBodies: Promise<void>[] = [];
            let cssBytes = 0;
            let htmlCaptured = false;
            page.on("response", (response) => {
              const request = response.request();
              if (request.resourceType() === "stylesheet" && result.stylesheets.length + cssBodies.length < 4) {
                cssBodies.push((async () => {
                  try {
                    const css = await response.text();
                    if (stopped || cssBytes >= MAX_CSS) return;
                    const excerpt = css.slice(0, MAX_CSS - cssBytes);
                    cssBytes += excerpt.length;
                    result.stylesheets.push({ url: response.url(), css: excerpt, truncated: excerpt.length < css.length });
                  } catch { if (!stopped) result.limitations.push("Could not read stylesheet: " + response.url()); }
                })());
              }
              if (!htmlCaptured && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                htmlCaptured = true;
                cssBodies.push((async () => {
                  try {
                    const html = await response.text();
                    if (stopped || result.html) return;
                    result.html = html.slice(0, MAX_HTML);
                    result.htmlTruncated = html.length > MAX_HTML;
                  } catch { /* Rendered DOM is still available below. */ }
                })());
              }
            });
            const response = await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 12_000 });
            if (response) result.status = response.status();
            try { await page.waitForLoadState("networkidle", { timeout: 3_000 }); }
            catch { result.limitations.push(viewport.device + ": network did not become idle; late assets may be missing."); }
            await page.evaluate(async () => {
              await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
              // Trigger lazy images within the captured region without interacting with controls.
              for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 4500); y += innerHeight) {
                scrollTo(0, y);
                await new Promise((resolve) => setTimeout(resolve, 80));
              }
              scrollTo(0, 0);
            });
            result.url = page.url();
            result.title = await page.title();
            if (!result.html) {
              const html = await page.content();
              result.html = html.slice(0, MAX_HTML);
              result.htmlTruncated = html.length > MAX_HTML;
              result.limitations.push("HTML excerpt is the rendered DOM, not the initial HTTP body.");
            }
            result.views.push(await inspectView(page, viewport.device, { width: viewport.width, height: viewport.height }));
            await Promise.race([Promise.allSettled(cssBodies), new Promise((resolve) => setTimeout(resolve, 1500))]);
            if (viewport.device === "desktop" && index === 0 && queue.length < MAX_PAGES) {
              const links = await page.locator("nav a[href], header a[href], main a[href]").evaluateAll((nodes) =>
                nodes.map((node) => ({ url: (node as HTMLAnchorElement).href, text: node.textContent ?? "" })),
              );
              const origin = new URL(result.url).origin;
              const internal = links.filter((link) => {
                try { const url = new URL(link.url); return url.origin === origin && !url.hash && !url.search && url.pathname !== "/" && !/\.(pdf|png|jpe?g|zip)$/i.test(url.pathname); }
                catch { return false; }
              }).sort((a, b) => Number(/service|team|about|pricing|model|work/i.test(b.text + b.url)) - Number(/service|team|about|pricing|model|work/i.test(a.text + a.url)));
              for (const link of internal) {
                if (queue.length >= MAX_PAGES) break;
                if (!queue.includes(link.url) && link.url !== result.url) queue.push(link.url);
              }
            }
          } catch (error) { if (!stopped) result.limitations.push(viewport.device + " inspection failed: " + errorText(error)); }
          finally { await context.close().catch(() => {}); }
        }
        if (result.htmlTruncated) result.limitations.push("HTML is a bounded excerpt; computed styles and screenshots supplement it.");
        if (result.stylesheets.some((sheet) => sheet.truncated)) result.limitations.push("Stylesheet bodies are bounded excerpts; computed styles describe the applied values.");
      } catch (error) { if (!stopped) result.limitations.push(errorText(error)); }
    }
  };
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          stopped = true;
          evidence.limitations.push("Website inspection reached its time limit; coverage may be partial.");
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (error) { evidence.limitations.push("Rendered inspection unavailable: " + errorText(error)); }
  finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
  return evidence;
}
