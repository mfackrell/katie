import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import type { WebsiteEvidence } from "@/lib/providers/types";

export type Bounds = { x: number; y: number; width: number; height: number };
export type VisualElement = {
  selector: string; tag: string; text: string; bounds: Bounds;
  visible: boolean; inFrame: boolean; control: boolean; hits: number;
  clipped: boolean; broken: boolean;
};
export type VisualFinding = {
  id: string; rule: "overflow" | "clipped-text" | "broken-image" | "occluded-control";
  selector: string; title: string; severity: "medium" | "high";
  source: "measured"; screenshotId: string; bounds: Bounds; evidence: VisualElement;
};
export type VisualFrame = {
  id: string; scrollY: number; screenshotHash: string;
  screenshot: { dataUrl: string; width: number; height: number; truncated: boolean };
  stable: boolean; elements: VisualElement[]; findings: VisualFinding[];
  purpose: "tile" | "occlusion-verification";
};
export type VisualReview = {
  version: 1; state: string; status: "complete" | "partial";
  coveredHeight: number; documentHeight: number; frames: VisualFrame[]; limitations: string[];
};
export type VisualBudget = { frames: number; bytes: number };
export type VisualComparison = {
  url: string; device: string; state: string; status: "compared" | "unverified";
  issues: Array<{ id: string; status: "resolved" | "persists" | "new" | "unverified" | "target_changed" | "target_missing_or_outside_capture" }>;
};

export function measure(frame: Pick<VisualFrame, "id" | "elements" | "screenshot">): VisualFinding[] {
  const findings: VisualFinding[] = [];
  const add = (rule: VisualFinding["rule"], e: VisualElement, title: string) => findings.push({
    id: rule + ":" + e.selector, rule, selector: e.selector, title,
    severity: rule === "occluded-control" ? "high" : "medium", source: "measured",
    screenshotId: frame.id, bounds: e.bounds, evidence: e,
  });
  for (const e of frame.elements) {
    if (!e.visible) continue;
    if (e.bounds.y >= 0 && e.bounds.y < frame.screenshot.height && (e.bounds.x < -2 || e.bounds.x + e.bounds.width > frame.screenshot.width + 2)) add("overflow", e, "Element extends beyond viewport");
    if (e.inFrame && e.clipped) add("clipped-text", e, "Content is clipped by its container");
    if (e.inFrame && e.broken) add("broken-image", e, "Image did not decode");
    if (e.inFrame && e.control && e.hits === 0) add("occluded-control", e, "Control is covered at all three tested points");
  }
  return findings;
}

async function snapshot(page: Page, budget: VisualBudget, purpose: VisualFrame["purpose"]) {
  if (budget.frames <= 0) throw new Error("Screenshot frame budget reached");
  const observed = await page.evaluate(() => {
    const selector = (e: Element) => {
      if (e.id && document.querySelectorAll("#" + CSS.escape(e.id)).length === 1) return "#" + CSS.escape(e.id);
      const parts: string[] = [];
      for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) {
        const tag = n.tagName;
        parts.unshift(tag.toLowerCase() + ":nth-of-type(" + (Array.from(n.parentElement?.children ?? []).filter(x => x.tagName === tag).indexOf(n) + 1) + ")");
      }
      return "body > " + parts.join(" > ");
    };
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,p,a,button,input,textarea,select,img,[role=button]"));
    const elements = candidates.slice(0, 500).map(e => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      const visible = e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0;
      const inFrame = visible && r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
      const control = e.matches("a,button,input,textarea,select,[role=button]");
      let hits = 0;
      if (inFrame && control) for (const fx of [.25, .5, .75]) {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * .5);
        if (hit && (hit === e || e.contains(hit))) hits++;
      }
      const intentional = ["auto", "scroll"].includes(s.overflowX) || ["auto", "scroll"].includes(s.overflowY) || s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none";
      return {
        selector: selector(e), tag: e.tagName, text: (e.innerText || e.getAttribute("aria-label") || e.getAttribute("alt") || "").slice(0, 250),
        visible, inFrame, control, hits, bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
        clipped: !intentional && visible && ([s.overflowX, s.overflowY].some(v => v === "hidden" || v === "clip")) && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2),
        broken: e instanceof HTMLImageElement && visible && e.complete && e.naturalWidth === 0,
      };
    }).filter(e => e.visible && e.bounds.y < innerHeight && e.bounds.y + e.bounds.height > 0);
    return { elements, total: candidates.length, scrollY, height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0), width: innerWidth, viewportHeight: innerHeight };
  });
  const options = { type: "jpeg" as const, quality: 70, animations: "disabled" as const, timeout: 5000 };
  const image = await page.screenshot(options);
  const repeat = await page.screenshot(options);
  if (image.length > 900_000 || image.length > budget.bytes) throw new Error("Screenshot byte budget reached");
  budget.frames--; budget.bytes -= image.length;
  const frame: VisualFrame = {
    id: randomUUID(), scrollY: observed.scrollY, screenshotHash: createHash("sha256").update(image).digest("hex"),
    screenshot: { dataUrl: "data:image/jpeg;base64," + image.toString("base64"), width: observed.width, height: observed.viewportHeight, truncated: false },
    stable: image.equals(repeat) && observed.total > 0 && observed.total <= 500,
    elements: observed.elements, findings: [], purpose,
  };
  frame.findings = measure(frame);
  return { frame, height: observed.height };
}

/** Uses the caller's guarded browser context. Never launches a second network path. */
export async function captureVisualReview(page: Page, budget: VisualBudget, state = "default", maxTiles = 24): Promise<VisualReview> {
  const review: VisualReview = { version: 1, state, status: "partial", coveredHeight: 0, documentHeight: 0, frames: [], limitations: [] };
  try {
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}" });
    let y = 0, previous = -1;
    for (let i = 0; i < maxTiles; i++) {
      await page.evaluate(top => scrollTo({ top, behavior: "instant" }), y);
      await page.waitForTimeout(80);
      await page.waitForFunction(() => Array.from(document.images).filter(img => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).every(img => img.complete), undefined, { timeout: 3000 });
      const { frame, height } = await snapshot(page, budget, "tile");
      if (frame.scrollY === previous) break;
      previous = frame.scrollY; review.frames.push(frame);
      review.coveredHeight = frame.scrollY + frame.screenshot.height; review.documentHeight = height;
      if (review.coveredHeight >= height - 1) break;
      y = review.coveredHeight - 80;
    }
    const suspects = [...new Set(review.frames.flatMap(f => f.findings).filter(f => f.rule === "occluded-control").map(f => f.selector))];
    for (const selector of suspects.slice(0, 10)) {
      const target = page.locator(selector);
      if (await target.count() !== 1) continue;
      await target.evaluate(e => e.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.waitForTimeout(80);
      const { frame } = await snapshot(page, budget, "occlusion-verification");
      const e = frame.elements.find(e => e.selector === selector);
      if (frame.stable && e?.inFrame && e.hits > 0) {
        for (const original of review.frames) original.findings = original.findings.filter(f => f.rule !== "occluded-control" || f.selector !== selector);
      }
      frame.findings = frame.findings.filter(f => f.selector === selector);
      review.frames.push(frame);
    }
    if (suspects.length > 10) review.limitations.push("Occlusion verification limit reached.");
    if (review.coveredHeight < review.documentHeight - 1) review.limitations.push("Tile limit reached before page end.");
    if (!review.frames.length || review.frames.some(f => !f.stable)) review.limitations.push("Blank, unstable or over-500-element capture; repair verification unavailable.");
    if (!review.limitations.length) review.status = "complete";
  } catch (error) { review.limitations.push("Visual capture incomplete: " + (error instanceof Error ? error.message : String(error))); }
  finally { await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" })).catch(() => {}); }
  return review;
}

function intact(review: VisualReview | undefined): boolean {
  if (!review || review.version !== 1 || !review.frames.length || review.frames.length > 60) return false;
  return review.frames.every(frame => frame.stable && frame.screenshot.dataUrl.startsWith("data:image/jpeg;base64,") &&
    createHash("sha256").update(Buffer.from(frame.screenshot.dataUrl.split(",")[1], "base64")).digest("hex") === frame.screenshotHash);
}

/** Measured-rule comparison only. A missing/replaced target is never a successful repair. */
export function compareWebsiteReviews(before: WebsiteEvidence, after: WebsiteEvidence): VisualComparison[] {
  const comparisons: VisualComparison[] = [];
  for (const page of before.pages) for (const view of page.views) {
    const b = view.visualReview;
    if (!b) continue;
    const currentPage = after.pages.find(p => p.url === page.url);
    const current = currentPage?.views.find(v => v.device === view.device && v.visualReview?.state === b.state && v.viewport.width === view.viewport.width && v.viewport.height === view.viewport.height);
    const a = current?.visualReview;
    const complete = b.status === "complete" && a?.status === "complete" && intact(b) && intact(a);
    const oldFindings = [...new Map(b.frames.flatMap(f => f.findings).map(f => [f.id, f])).values()];
    const newFindings = [...new Map(a?.frames.flatMap(f => f.findings).map(f => [f.id, f]) ?? []).values()];
    const issues: VisualComparison["issues"] = oldFindings.map(f => {
      const targets = a?.frames.flatMap(f => f.elements).filter(e => e.selector === f.selector && e.visible && e.inFrame) ?? [];
      const status = !complete ? "unverified" : newFindings.some(n => n.id === f.id) ? "persists" : !targets.length ? "target_missing_or_outside_capture" : !targets.some(e => e.tag === f.evidence.tag && e.text === f.evidence.text) ? "target_changed" : "resolved";
      return { id: f.id, status };
    });
    for (const f of newFindings) if (!oldFindings.some(n => n.id === f.id)) issues.push({ id: f.id, status: "new" });
    comparisons.push({ url: page.url, device: view.device, state: b.state, status: complete ? "compared" : "unverified", issues });
  }
  return comparisons;
}
