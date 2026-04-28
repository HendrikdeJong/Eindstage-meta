#!/usr/bin/env node
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const LIST_URL =
  process.env.SCRAPE_NEWS_LIST_URL ??
  "https://www.whisperpower.com/all-articles";
const AJAX_URL =
  process.env.SCRAPE_NEWS_AJAX_URL ??
  "https://www.whisperpower.com/core/wp-admin/admin-ajax.php";
const AJAX_ACTION = process.env.SCRAPE_NEWS_AJAX_ACTION ?? "loadpost";
const AJAX_SECURITY = process.env.SCRAPE_NEWS_AJAX_SECURITY ?? "88bdf301a6";
const PAGE_SIZE = Number(process.env.SCRAPE_NEWS_PAGE_SIZE ?? "15");
const AJAX_CATEGORY = process.env.SCRAPE_NEWS_AJAX_CAT ?? "false";
const OUTPUT_FILE =
  process.env.SCRAPE_NEWS_OUTPUT ??
  path.resolve(process.cwd(), "data/news.json");
const MAX_ARTICLES = Number(process.env.SCRAPE_NEWS_MAX_ARTICLES ?? "200");
const CONCURRENCY = 4;

function toAbsoluteUrl(raw, base) {
  if (!raw) return "";
  try {
    return new URL(raw, base).toString();
  } catch {
    return "";
  }
}

function slugFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? "article";
  } catch {
    return "article";
  }
}

function normalizeImageSource($img, baseUrl) {
  const src =
    $img.attr("data-src") ||
    $img.attr("data-lazy-src") ||
    $img.attr("src") ||
    "";
  return toAbsoluteUrl(src, baseUrl);
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function getJsonLdItems(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) return parsed;
    if (parsed?.["@graph"] && Array.isArray(parsed["@graph"])) {
      return parsed["@graph"];
    }
    return [parsed];
  } catch {
    return [];
  }
}

function isArticleType(type) {
  const typeList = Array.isArray(type) ? type : [type];
  return (
    typeList.includes("NewsArticle") ||
    typeList.includes("BlogPosting") ||
    typeList.includes("Article")
  );
}

function extractJsonLdDate($) {
  const scripts = $('script[type="application/ld+json"]');
  for (const script of scripts.toArray()) {
    const raw = $(script).text();
    if (!raw) continue;

    const items = getJsonLdItems(raw);
    for (const item of items) {
      if (isArticleType(item?.["@type"])) {
        const published = item.datePublished || item.dateCreated;
        const modified = item.dateModified;
        return { published, modified };
      }
    }
  }

  // Fallback: <meta property="article:published_time"> / og:updated_time
  const metaPublished =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[name="publish-date"]').attr("content") ||
    $('meta[name="date"]').attr("content");
  const metaModified =
    $('meta[property="article:modified_time"]').attr("content") ||
    $('meta[property="og:updated_time"]').attr("content");

  if (metaPublished)
    return { published: metaPublished, modified: metaModified ?? null };

  // Fallback: first <time datetime="..."> in the article
  const timeEl = $("time[datetime]").first();
  if (timeEl.length) {
    return { published: timeEl.attr("datetime"), modified: null };
  }

  return { published: null, modified: null };
}

const NOISE_SELECTORS =
  "header, footer, nav, aside, form, script, style, .menu, .navigation, .sidebar, .widget, .breadcrumb, .wp-block-navigation, .social-share, .card-cta";

function pickContentContainer($article) {
  // WhisperPower detail pages: article.main contains fc-content sections
  const wpMain = $article("article.main").first();
  if (wpMain.length > 0) {
    wpMain.find(NOISE_SELECTORS).remove();
    // Only keep the primary content column, not the aside column
    const contentCell = wpMain
      .find(".cell.large-13, .cell.large-offset-2.large-13")
      .first();
    if (contentCell.length > 0) return contentCell;
    return wpMain;
  }

  const candidates = [
    $article("article .entry-content").first(),
    $article("main article").first(),
    $article("#main .section-overview").first(),
  ];

  for (const candidate of candidates) {
    if (candidate.length > 0) {
      candidate.find(NOISE_SELECTORS).remove();
      return candidate;
    }
  }

  return null;
}

function htmlToMarkdown($container) {
  if (!$container) return "";
  const lines = [];

  $container.find("h1, h2, h3, h4, p, blockquote").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = cheerio.load(el).text().trim();
    if (!text) return;

    if (tag === "h1") lines.push(`# ${text}`);
    else if (tag === "h2") lines.push(`## ${text}`);
    else if (tag === "h3" || tag === "h4") lines.push(`### ${text}`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else lines.push(text);
  });

  return lines.join("\n\n").trim();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "whispercare-news-scraper/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return await response.text();
}

async function fetchAjaxCardsHtml(offset, nonce) {
  const body = new URLSearchParams({
    action: AJAX_ACTION,
    offset: String(offset),
    security: nonce,
    cat: AJAX_CATEGORY,
  });

  const response = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "User-Agent": "whispercare-news-scraper/1.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "text/html,application/xhtml+xml,*/*",
      Referer: LIST_URL,
      Origin: "https://www.whisperpower.com",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ajax news page`);
  }

  return await response.text();
}

function extractCardsFromHtml(html, baseUrl) {
  const $ = cheerio.load(`<div id="scrape-root">${html}</div>`);
  const cards = $("article.card-news").toArray();

  return cards
    .map((card) => {
      const $card = $(card);
      const anchor = $card.find("a").first();
      const href = toAbsoluteUrl(anchor.attr("href") || "", baseUrl);
      const title =
        (anchor.attr("title") || "").trim() ||
        $card.find(".card-content .h5").first().text().trim();
      const category = $card.find(".post-data .label").first().text().trim();
      const imageUrl = normalizeImageSource($card.find("img").first(), baseUrl);

      if (!href || !title) return null;

      const slug = slugFromUrl(href);
      return {
        id: slug,
        slug,
        href,
        title,
        category: category || "News",
        imageUrl,
      };
    })
    .filter(Boolean);
}

function extractLoadMoreMeta(html) {
  const $ = cheerio.load(html);
  const btn = $("#loadmore");
  return {
    // data-nonce is a session token rendered into the button on each page load
    nonce: btn.attr("data-nonce") ?? AJAX_SECURITY,
    serverTotal: Number(btn.attr("data-total") ?? "0"),
    // data-offset is where AJAX pagination starts (after the initial server render)
    initialOffset: Number(btn.attr("data-offset") ?? String(PAGE_SIZE)),
  };
}

function collectUniqueCards(cards, seen, all) {
  for (const item of cards) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    all.push(item);
    if (all.length >= MAX_ARTICLES) break;
  }
}

async function fetchSeedArticlesViaAjax() {
  const listHtml = await fetchText(LIST_URL);
  const { nonce, serverTotal, initialOffset } = extractLoadMoreMeta(listHtml);

  const all = [];
  const seen = new Set();

  collectUniqueCards(extractCardsFromHtml(listHtml, LIST_URL), seen, all);

  let offset = initialOffset;
  while (
    all.length < MAX_ARTICLES &&
    (serverTotal === 0 || offset < serverTotal)
  ) {
    const html = await fetchAjaxCardsHtml(offset, nonce);
    const pageCards = extractCardsFromHtml(html, LIST_URL);

    if (pageCards.length === 0) break;
    collectUniqueCards(pageCards, seen, all);

    offset += PAGE_SIZE;
  }

  return all;
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
  );

  return results;
}

async function loadExistingArticles() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.articles) ? data.articles : [];
    return new Map(list.map((a) => [a.slug, a]));
  } catch {
    return new Map();
  }
}

async function scrapeArticle(seed) {
  const articleHtml = await fetchText(seed.href);
  const $article = cheerio.load(articleHtml);

  const ogTitle = $article('meta[property="og:title"]').attr("content") || "";
  const ogDescription =
    $article('meta[property="og:description"]').attr("content") ||
    $article('meta[name="description"]').attr("content") ||
    "";
  const ogImage =
    $article('meta[property="og:image"]').attr("content") || seed.imageUrl;

  const { published, modified } = extractJsonLdDate($article);
  const contentContainer = pickContentContainer($article);
  const contentMarkdown = htmlToMarkdown(contentContainer);

  const gallery = [];
  (contentContainer ?? $article("body")).find("img").each((_, img) => {
    if (gallery.length >= 8) return;
    const $img = $article(img);
    const url = normalizeImageSource($img, seed.href);
    if (
      !url ||
      /\/res\/flags\//.test(url) ||
      /-\d+x\d+\.\w+$/.test(url) ||
      /\/themes\//.test(url)
    )
      return;
    gallery.push({
      url,
      alt: ($img.attr("alt") || seed.title || "Article image").trim(),
    });
  });

  const excerpt = (ogDescription || seed.title).trim();

  return {
    id: seed.id,
    slug: seed.slug,
    title: (ogTitle || seed.title).trim(),
    subtitle: "",
    excerpt,
    publishedAt: toIsoDate(published),
    updatedAt: modified ? toIsoDate(modified) : undefined,
    category: seed.category,
    tags: [seed.category.toLowerCase()],
    bannerImage: { url: ogImage, alt: seed.title },
    gallery,
    contentMarkdown:
      contentMarkdown.length > 0
        ? contentMarkdown
        : `${excerpt}\n\n[Read full article](${seed.href})`,
    cta: { label: "Read Original", url: seed.href },
  };
}

async function scrape() {
  console.log("Starting WhisperPower news scrape...");

  const existing = await loadExistingArticles();
  console.log(`Cache: ${existing.size} existing article(s) loaded`);

  let seedArticles = [];
  try {
    seedArticles = await fetchSeedArticlesViaAjax();
  } catch (error) {
    console.warn(
      `AJAX scraping failed, falling back to list page: ${String(error)}`,
    );
    const listHtml = await fetchText(LIST_URL);
    seedArticles = extractCardsFromHtml(listHtml, LIST_URL).slice(
      0,
      MAX_ARTICLES,
    );
  }
  console.log(`Website: found ${seedArticles.length} article(s)`);

  const newSeeds = seedArticles.filter((s) => !existing.has(s.slug));
  const cachedCount = seedArticles.length - newSeeds.length;
  console.log(`New: ${newSeeds.length} | Cached (skipped): ${cachedCount}`);

  const freshlyScraped = await mapWithConcurrency(
    newSeeds,
    async (seed, i) => {
      console.log(`  [${i + 1}/${newSeeds.length}] Scraping "${seed.title}"`);
      try {
        return await scrapeArticle(seed);
      } catch (error) {
        console.warn(
          `  [${i + 1}/${newSeeds.length}] Failed "${seed.slug}": ${String(error)}`,
        );
        return {
          id: seed.id,
          slug: seed.slug,
          title: seed.title,
          subtitle: "",
          excerpt: seed.title,
          publishedAt: new Date().toISOString(),
          category: seed.category,
          tags: [seed.category.toLowerCase()],
          bannerImage: { url: seed.imageUrl, alt: seed.title },
          gallery: [],
          contentMarkdown: `Could not scrape full content.\n\n[Read original](${seed.href})`,
          cta: { label: "Read Original", url: seed.href },
        };
      }
    },
    CONCURRENCY,
  );

  // Merge: preserve website fetch order (newest-first); prefer fresh over cached
  const freshMap = new Map(freshlyScraped.map((a) => [a.slug, a]));
  const merged = seedArticles
    .map((seed) => freshMap.get(seed.slug) ?? existing.get(seed.slug))
    .filter(Boolean);

  // Sort by date when articles differ by >1 day; otherwise keep website order
  const normalized = merged
    .map((article, fetchIndex) => ({ ...article, _fetchIndex: fetchIndex }))
    .sort((a, b) => {
      const dateA = new Date(a.publishedAt).getTime();
      const dateB = new Date(b.publishedAt).getTime();
      if (Math.abs(dateA - dateB) > 24 * 60 * 60 * 1000) return dateB - dateA;
      return a._fetchIndex - b._fetchIndex;
    })
    .map(({ _fetchIndex, ...article }) => article);

  const newSlugs = newSeeds.map((s) => s.slug);
  if (newSlugs.length > 0) {
    const lines = newSlugs.map((s) => `  + ${s}`).join("\n");
    console.log(`\nNew articles added:\n${lines}`);
  } else {
    console.log("\nNo new articles found — nothing to add");
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(
    OUTPUT_FILE,
    `${JSON.stringify({ articles: normalized }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Written ${normalized.length} article(s) to ${OUTPUT_FILE}`);

  const metaPath = OUTPUT_FILE.replace(/\.json$/, "-meta.json");
  await fs.writeFile(
    metaPath,
    `${JSON.stringify(
      {
        scrapedAt: new Date().toISOString(),
        totalArticles: normalized.length,
        newArticles: newSlugs.length,
        newSlugs,
        latestSlug: normalized[0]?.slug ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Metadata written to ${metaPath}`);
}

try {
  await scrape();
} catch (error) {
  console.error(error);
  process.exit(1);
}
