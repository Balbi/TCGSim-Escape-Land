#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const API_URL = 'https://escape-land-promo.com/api/apps/6983607223fa2143ab594a4a/entities/Card';
const CROP_HEIGHT_FACTOR = 0.91;
const CROP_WIDTH_FACTOR = 0.879;
const MAX_OUTPUT_HEIGHT = 1024;
const JPEG_QUALITY = 80;
const CONCURRENCY = 6;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = path.resolve(__dirname, '..');
const cardsJsonPath = path.join(gameRoot, 'EscapeLand_Cards.json');
const cardsImageDir = path.join(gameRoot, 'images', 'cards');

const defaultImageBaseUrl = 'https://balbi.github.io/TCGSim-Escape-Land/images/cards';
const imageBaseUrl = (process.env.ESCAPE_LAND_IMAGE_BASE_URL || defaultImageBaseUrl).replace(/\/+$/, '');

const toSlug = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const normalizeCardName = (value, index) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length ? trimmed : `Unnamed Card ${index + 1}`;
};

const ensureUniqueId = (candidate, usedIds) => {
  let next = candidate;
  let bump = 2;
  while (usedIds.has(next)) {
    next = `${candidate}-${String(bump).padStart(2, '0')}`;
    bump += 1;
  }
  usedIds.add(next);
  return next;
};

const toCardId = (card, index, usedIds) => {
  const numericCardNumber = Number(card.card_number);
  if (Number.isFinite(numericCardNumber) && numericCardNumber > 0) {
    return ensureUniqueId(`EL-${String(Math.trunc(numericCardNumber)).padStart(3, '0')}`, usedIds);
  }

  const sourceId = typeof card.id === 'string' ? card.id.trim() : '';
  if (sourceId.length) {
    return ensureUniqueId(sourceId, usedIds);
  }

  const slug = toSlug(card.name) || `card-${index + 1}`;
  return ensureUniqueId(`el-${slug}`, usedIds);
};

const resolveCardArray = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
  }
  throw new Error('Unexpected card API payload shape; expected an array');
};

const runPool = async (items, worker, concurrency = CONCURRENCY) => {
  const queue = [...items];
  const active = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await worker(next);
    }
  });
  await Promise.all(active);
};

const buildOutputCard = ({ source, id, imageFileName, alternateOf }) => {
  const type = typeof source.card_type === 'string' && source.card_type.trim().length > 0 ? source.card_type.trim() : 'Unit';
  const numericCost = Number(source.cost);

  return {
    id,
    name: source.name,
    type,
    image: `${imageBaseUrl}/${imageFileName}`,
    cost: Number.isFinite(numericCost) ? numericCost : 0,
    isToken: false,
    isHorizontal: false,
    alternateOf,
    props: {
      Rarity: source.rarity ?? null,
      Traits: Array.isArray(source.traits) ? source.traits : [],
      Rating: source.rating ?? null,
      CardNumber: source.card_number ?? null,
      SourceId: source.id ?? null
    }
  };
};

const processImage = async (sourceUrl, outputFilePath) => {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}) for ${sourceUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const input = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await input.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to determine image dimensions for ${sourceUrl}`);
  }

  const cropWidth = Math.max(1, Math.round(metadata.width * CROP_WIDTH_FACTOR));
  const cropHeight = Math.max(1, Math.round(metadata.height * CROP_HEIGHT_FACTOR));
  const left = Math.max(0, Math.floor((metadata.width - cropWidth) / 2));
  const top = Math.max(0, Math.floor((metadata.height - cropHeight) / 2));

  const processed = await input
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ height: MAX_OUTPUT_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();

  await fs.writeFile(outputFilePath, processed);
};

const main = async () => {
  await fs.mkdir(cardsImageDir, { recursive: true });

  const apiResponse = await fetch(API_URL);
  if (!apiResponse.ok) {
    throw new Error(`Failed to fetch card data (${apiResponse.status}) from Escape Land API`);
  }

  const payload = await apiResponse.json();
  const sourceCards = resolveCardArray(payload);

  const usedIds = new Set();
  const normalized = sourceCards.map((source, index) => {
    const name = normalizeCardName(source.name, index);
    const id = toCardId({ ...source, name }, index, usedIds);
    const imageFileName = `${toSlug(name) || 'card'}-${id}.jpg`;

    return {
      source: {
        ...source,
        name
      },
      id,
      imageFileName
    };
  });

  const primaryIdByName = new Map();
  normalized.forEach((entry) => {
    primaryIdByName.set(entry.source.name, entry.id);
  });

  await runPool(normalized, async (entry) => {
    const sourceUrl = typeof entry.source.image_url === 'string' ? entry.source.image_url.trim() : '';
    if (!sourceUrl) {
      throw new Error(`Card "${entry.source.name}" (${entry.id}) is missing image_url`);
    }
    const outputPath = path.join(cardsImageDir, entry.imageFileName);
    await processImage(sourceUrl, outputPath);
  });

  const outputCards = normalized.map((entry) => {
    const primaryId = primaryIdByName.get(entry.source.name);
    const alternateOf = primaryId && primaryId !== entry.id ? primaryId : null;
    return buildOutputCard({
      source: entry.source,
      id: entry.id,
      imageFileName: entry.imageFileName,
      alternateOf
    });
  });

  await fs.writeFile(cardsJsonPath, `${JSON.stringify(outputCards, null, 2)}\n`, 'utf8');

  console.log(`Synced ${outputCards.length} cards to ${cardsJsonPath}`);
  console.log(`Processed card images into ${cardsImageDir}`);
  console.log(`Image base URL in card data: ${imageBaseUrl}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
