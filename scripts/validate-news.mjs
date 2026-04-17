#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NEWS_FILE =
  process.env.SCRAPE_NEWS_OUTPUT ??
  path.resolve(process.cwd(), "data/news.json");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validateImage(image, fieldPath, errors) {
  if (!image || typeof image !== "object") {
    errors.push(`${fieldPath} must be an object`);
    return;
  }

  if (!isNonEmptyString(image.url)) {
    errors.push(`${fieldPath}.url must be a non-empty string`);
  }

  if (!isNonEmptyString(image.alt)) {
    errors.push(`${fieldPath}.alt must be a non-empty string`);
  }

  if (!isOptionalString(image.caption)) {
    errors.push(`${fieldPath}.caption must be a string when provided`);
  }

  if (!isOptionalString(image.credit)) {
    errors.push(`${fieldPath}.credit must be a string when provided`);
  }
}

function validateArticle(article, index, errors, seenIds) {
  const base = `articles[${index}]`;

  if (!article || typeof article !== "object") {
    errors.push(`${base} must be an object`);
    return;
  }

  const requiredStringFields = [
    "id",
    "slug",
    "title",
    "excerpt",
    "publishedAt",
    "contentMarkdown",
  ];

  for (const field of requiredStringFields) {
    if (!isNonEmptyString(article[field])) {
      errors.push(`${base}.${field} must be a non-empty string`);
    }
  }

  if (isNonEmptyString(article.id)) {
    if (seenIds.has(article.id)) {
      errors.push(`${base}.id must be unique (duplicate: ${article.id})`);
    }
    seenIds.add(article.id);
  }

  if (!isOptionalString(article.subtitle)) {
    errors.push(`${base}.subtitle must be a string when provided`);
  }

  if (!isOptionalString(article.updatedAt)) {
    errors.push(`${base}.updatedAt must be a string when provided`);
  }

  if (!isOptionalString(article.category)) {
    errors.push(`${base}.category must be a string when provided`);
  }

  if (
    article.tags !== undefined &&
    !(Array.isArray(article.tags) && isStringArray(article.tags))
  ) {
    errors.push(`${base}.tags must be an array of strings when provided`);
  }

  validateImage(article.bannerImage, `${base}.bannerImage`, errors);

  if (article.gallery !== undefined) {
    if (!Array.isArray(article.gallery)) {
      errors.push(`${base}.gallery must be an array when provided`);
    } else {
      article.gallery.forEach((image, imageIndex) => {
        validateImage(image, `${base}.gallery[${imageIndex}]`, errors);
      });
    }
  }

  if (article.cta !== undefined) {
    if (!article.cta || typeof article.cta !== "object") {
      errors.push(`${base}.cta must be an object when provided`);
    } else {
      if (!isNonEmptyString(article.cta.label)) {
        errors.push(`${base}.cta.label must be a non-empty string`);
      }
      if (!isNonEmptyString(article.cta.url)) {
        errors.push(`${base}.cta.url must be a non-empty string`);
      }
    }
  }

  if (isNonEmptyString(article.publishedAt)) {
    const published = new Date(article.publishedAt);
    if (Number.isNaN(published.getTime())) {
      errors.push(`${base}.publishedAt must be a valid ISO date string`);
    }
  }

  if (isNonEmptyString(article.updatedAt)) {
    const updated = new Date(article.updatedAt);
    if (Number.isNaN(updated.getTime())) {
      errors.push(`${base}.updatedAt must be a valid ISO date string`);
    }
  }
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(NEWS_FILE, "utf8");
  } catch (error) {
    console.error(`Could not read ${NEWS_FILE}: ${String(error)}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid JSON in ${NEWS_FILE}: ${String(error)}`);
    process.exit(1);
  }

  const errors = [];
  const seenIds = new Set();

  if (!parsed || typeof parsed !== "object") {
    errors.push("Root payload must be an object");
  }

  if (!Array.isArray(parsed.articles)) {
    errors.push("Root payload.articles must be an array");
  } else {
    parsed.articles.forEach((article, index) => {
      validateArticle(article, index, errors, seenIds);
    });
  }

  if (errors.length > 0) {
    console.error(`Validation failed for ${NEWS_FILE}`);
    errors.slice(0, 40).forEach((error) => console.error(`- ${error}`));
    if (errors.length > 40) {
      console.error(`...and ${errors.length - 40} more errors`);
    }
    process.exit(1);
  }

  console.log(
    `Validated ${NEWS_FILE}: ${parsed.articles.length} articles, schema OK`,
  );
}

await main();
