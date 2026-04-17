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
const MAX_PAGES = Number(process.env.SCRAPE_NEWS_MAX_PAGES ?? "8");
const AJAX_CATEGORY = process.env.SCRAPE_NEWS_AJAX_CAT ?? "false";
const OUTPUT_FILE =
  process.env.SCRAPE_NEWS_OUTPUT ??
  path.resolve(process.cwd(), "data/news.json");
const MAX_ARTICLES = Number(process.env.SCRAPE_NEWS_MAX_ARTICLES ?? "40");
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
  return { published: null, modified: null };
}

const NOISE_SELECTORS = "header, footer, nav, aside, form, script, style, .menu, .navigation, .sidebar, .widget, .breadcrumb, .wp-block-navigation";

function pickContentContainer($article) {
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

async function fetchAjaxCardsHtml(offset) {
  const body = new URLSearchParams({
    action: AJAX_ACTION,
    offset: String(offset),
    security: AJAX_SECURITY,
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

async function fetchSeedArticlesViaAjax() {
  const all = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const html = await fetchAjaxCardsHtml(offset);
    const pageCards = extractCardsFromHtml(html, LIST_URL);

    if (pageCards.length === 0) break;

    let addedThisPage = 0;
    for (const item of pageCards) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
      addedThisPage += 1;
      if (all.length >= MAX_ARTICLES) return all;
    }

    if (addedThisPage === 0) break;
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

async function scrape() {
  let seedArticles = [];

  try {
    seedArticles = await fetchSeedArticlesViaAjax();
  } catch (error) {
    console.warn(
      `Ajax scraping failed, falling back to list page parsing: ${String(error)}`,
    );

    const listHtml = await fetchText(LIST_URL);
    seedArticles = extractCardsFromHtml(listHtml, LIST_URL).slice(
      0,
      MAX_ARTICLES,
    );
  }

  const detailed = await mapWithConcurrency(
    seedArticles,
    async (seed) => {
      try {
        const articleHtml = await fetchText(seed.href);
        const $article = cheerio.load(articleHtml);

        const ogTitle =
          $article('meta[property="og:title"]').attr("content") || "";
        const ogDescription =
          $article('meta[property="og:description"]').attr("content") ||
          $article('meta[name="description"]').attr("content") ||
          "";
        const ogImage =
          $article('meta[property="og:image"]').attr("content") ||
          seed.imageUrl;

        const { published, modified } = extractJsonLdDate($article);

        const contentContainer = pickContentContainer($article);

        const contentMarkdown = htmlToMarkdown(contentContainer);

        const gallery = [];
        (contentContainer ?? $article("body")).find("img").each((_, img) => {
          if (gallery.length >= 8) return;
          const $img = $article(img);
          const url = normalizeImageSource($img, seed.href);
          if (!url) return;
          if (/\/res\/flags\//.test(url)) return;
          if (/-\d+x\d+\.\w+$/.test(url)) return;
          if (/\/themes\//.test(url)) return;
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
          bannerImage: {
            url: ogImage,
            alt: seed.title,
          },
          gallery,
          contentMarkdown:
            contentMarkdown.length > 0
              ? contentMarkdown
              : `${excerpt}\n\n[Read full article](${seed.href})`,
          cta: {
            label: "Read Original",
            url: seed.href,
          },
        };
      } catch (error) {
        return {
          id: seed.id,
          slug: seed.slug,
          title: seed.title,
          subtitle: "",
          excerpt: seed.title,
          publishedAt: new Date().toISOString(),
          category: seed.category,
          tags: [seed.category.toLowerCase()],
          bannerImage: {
            url: seed.imageUrl,
            alt: seed.title,
          },
          gallery: [],
          contentMarkdown: `Could not scrape full content.\n\n[Read original](${seed.href})`,
          cta: {
            label: "Read Original",
            url: seed.href,
          },
          scrapeError: String(error),
        };
      }
    },
    CONCURRENCY,
  );

  const normalized = detailed
    .map((article) => {
      const { scrapeError, ...clean } = article;
      return clean;
    })
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );

  const payload = {
    articles: normalized,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  console.log(`Scraped ${normalized.length} articles to ${OUTPUT_FILE}`);
}

try {
  await scrape();
} catch (error) {
  console.error(error);
  process.exit(1);
}
