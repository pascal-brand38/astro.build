import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import slugify from 'slugify';
import glob from 'tiny-glob';
import * as yaml from 'yaml';
import {
	badgeForPackage,
	blocklist,
	getCategoriesForKeyword,
	getOverrides,
	getToolbarPackagePriority,
	isNewPackage,
} from './integrations.mjs';
import { markdownToPlainText } from './markdown.mjs';
import { fetchDetailsForPackage, fetchDownloadsForPackage, searchByKeyword } from './npm.mjs';

/** @param {string} pkg */
function isOfficial(pkg) {
	return pkg.startsWith('@astrojs/');
}

/** @param {string} url */
function sanitizeGitHubUrl(url) {
	return url
		.replace('git+', '')
		.replace('.git', '')
		.replace('git:', 'https:')
		.replace('git@github.com:', 'https://github.com/');
}

function updateLastModified() {
	const pathname = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../src/data/last-modified.json',
	);
	const json = fs.readFileSync(pathname, { encoding: 'utf8' });
	const data = JSON.parse(json);
	data.integrations = new Date().toUTCString();
	fs.writeFileSync(pathname, JSON.stringify(data, null, '\t'), { encoding: 'utf8' });
}

async function getIntegrationFiles() {
	return await glob('src/content/integrations/*.md', {
		cwd: path.resolve(fileURLToPath(import.meta.url), '../..'),
	});
}

/**
 * @param {NonNullable<Awaited<ReturnType<typeof fetchDetailsForPackage>>>} data
 * @param {string} pkg
 */
function normalizePackageDetails(data, pkg) {
	const keywordCategories = (data.keywords ?? []).flatMap(getCategoriesForKeyword);

	if (keywordCategories.length === 0) {
		keywordCategories.push('uncategorized');
	}

	const toolbar = getToolbarPackagePriority(pkg);
	const official = isOfficial(pkg);

	const otherCategories = [
		official ? 'official' : undefined,
		toolbar ? 'toolbar' : undefined,
		isNewPackage(data) ? 'recent' : undefined,
	].filter(Boolean);

	const uniqCategories = Array.from(new Set([...keywordCategories, ...otherCategories]));

	const npmUrl = `https://www.npmjs.com/package/${pkg}`;

	const repoUrl = data.repository && sanitizeGitHubUrl(data.repository);

	let homepageUrl = npmUrl;
	// The `homepage` field is user-authored, so sometimes funky values can end up here.
	// This is just a brief sanity check that things looks vaguely like a URL.
	if (data.homepage?.toLowerCase().startsWith('https')) {
		homepageUrl = data.homepage;
	}

	return {
		name: data.name,
		title: data.name,
		description: markdownToPlainText(data.description),
		categories: uniqCategories,
		npmUrl,
		repoUrl,
		homepageUrl,
		official: official === true ? true : undefined,
	};
}

/** @param {string} pkg */
async function fetchWithOverrides(pkg, includeDownloads = true) {
	const details = await fetchDetailsForPackage(pkg);
	if (!details) return;
	const integrationOverrides = getOverrides(pkg) || {};

	const badge = badgeForPackage(details);
	const toolbar = getToolbarPackagePriority(pkg);

	return {
		...normalizePackageDetails(details, pkg),
		...integrationOverrides,
		badge,
		toolbar,
		...(includeDownloads ? { downloads: await fetchDownloadsForPackage(pkg) } : {}),
	};
}

async function unsafeUpdateAllIntegrations() {
	const keyword = 'astro-component,withastro,astro-integration';

	const packagesMap = await searchByKeyword(keyword);
	const searchResults = new Set([...packagesMap.keys()].filter((pkg) => !blocklist.includes(pkg)));

	const entries = await getIntegrationFiles();

	const existingIntegrations = new Set();
	/** @type {string[]} */
	const deprecatedIntegrations = [];

	// loop through all integrations already published to the catalog
	await Promise.all(
		entries.map(async (entry) => {
			const { data } = matter.read(entry);
			existingIntegrations.add(data.name);

			if (!searchResults.has(data.name)) {
				// the integration was deprecated or removed from NPM
				deprecatedIntegrations.push(data.name);
				fs.rmSync(entry);
			} else {
				// fetch the latest NPM data, keeping any local overrides like description or icon
				// skipping download counts here since existing integrations will be updated
				// automatically in a separate GitHub Action.
				const details = await fetchWithOverrides(data.name, false);
				if (!details) return;

				const frontmatter = yaml.stringify({
					...data,
					...details,
					badges: undefined,
				});

				fs.writeFileSync(
					entry,
					`---
${frontmatter}---\n`,
				);
			}
		}),
	);

	// find new integrations that haven't been published yet
	const newIntegrations = Array.from(searchResults.keys()).filter(
		(pkg) => !existingIntegrations.has(pkg),
	);

	await Promise.all(
		newIntegrations.map(async (entry) => {
			const details = await fetchWithOverrides(entry);
			if (!details) return;

			const frontmatter = yaml.stringify(details);

			const slug = slugify(entry);
			const file = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				`../src/content/integrations/${slug}.md`,
			);

			fs.writeFileSync(
				file,
				`---
${frontmatter}---\n`,
			);
		}),
	);

	updateLastModified();

	// logging in case we need to audit the nightly job
	let stats = `\n--- Update Integrations ---
Updated: ${existingIntegrations.size - deprecatedIntegrations.length} integrations`;

	if (newIntegrations.length) {
		stats += `\n\nAdded:${newIntegrations.map((pkg) => `\n  + ${pkg}`)}`;
	}

	if (deprecatedIntegrations.length) {
		stats += `\n\nRemoved:${deprecatedIntegrations.map((pkg) => `\n  - ${pkg}`)}`;
	}

	stats += '\n---------------------------';

	console.info(stats);
}

import https from 'https'
import axios from 'axios'

// timeout on Check https://www.npmjs.com/package/@lightnet/decap-admin ?
const checkUrl = async (url, urlsStatus) => {
  urlsStatus.total ++

  // console.log(`Check ${url}`)
  try {
    await axios.head(url, {timeout: 10000});
  } catch (error) {
    if (!error.response) {
      // can be the case when the hostname does not exist
      // console.log(error)
      urlsStatus.timeout.push(url)
      return false
    }
    // console.log(error)
    if (error.response.status === 404) {
      urlsStatus.error404.push(url)
      return false
    }
    if (error.response.status >= 400) {
      urlsStatus.errorOther.push(url)
      return false
    }
  }
  urlsStatus.ok.push(url)
  return true
}


// async function checkUrl(url) {
//   function httpRequest(url) {
//     return new Promise(function(resolve, reject) {
//       const req = https.request(url, { method: 'HEAD' }, function(r) {
//         console.log('PASCAL')
//         console.log(JSON.stringify(r.headers));
//         console.log('PASCAL')
//         return resolve()
//       });
//       req.end();
//     })
//   }
//   console.log(`Check ${url}`)
//   await httpRequest(url)
// }

async function safeUpdateExistingIntegrations() {
	const entries = await getIntegrationFiles();
  // const entries = [ 'src/content/integrations/astro-sprite.md' ]

  let index = 0
  let urlsStatus = {
    total: 0,
    ok: [],
    error404: [],
    timeout: [],
    errorOther: [],
  }
	for (const entry of entries) {
    if (index % 100 === 0) {
      console.log(`Checking index ${index}`)
    }
    index = index + 1

		const { data } = matter.read(entry);
    const verbose = (data.name === 'astro-sprite')

    const exits = await checkUrl(data.homepageUrl, urlsStatus)
    if (!exits) {
      console.log(`Cannot access homepage of ${data.name}: ${data.homepageUrl}`)
    }

    // {
    //   name: 'astro-sprite',
    //   title: 'astro-sprite',
    //   description: 'Sprite generation (png, webp, avif...) dedicated Astro framework',
    //   categories: [ 'css+ui', 'media', 'recent' ],
    //   npmUrl: 'https://www.npmjs.com/package/astro-sprite',
    //   repoUrl: 'https://github.com/pascal-brand38/astro-sprite',
    //   homepageUrl: 'https://github.com/pascal-brand38/astro-sprite#readme',
    //   badge: 'new',
    //   downloads: 277
    // }


    // if (verbose) {
    //   console.log(entry)
    //   console.log(data)
    // }

		// only override NPM download stats for safe updates
    if (false){
    console.log('before fetchDownloadsForPackage')
		const downloads = await fetchDownloadsForPackage(data.name);
    console.log('after fetchDownloadsForPackage')

		const frontmatter = yaml.stringify({
			...data,
			downloads,
			badges: undefined,
		});

		fs.writeFileSync(
			entry,
			`---
${frontmatter}---\n`,
		);
	}
  }
  console.log(`Number of checked urls: ${urlsStatus.total}`)
  console.log(`Number of ok:           ${urlsStatus.ok.length}`)
  console.log(`Number of timeout:      ${urlsStatus.timeout.length}`)
  console.log(`Number of 404:          ${urlsStatus.error404.length}`)
  console.log(`Number of other errors: ${urlsStatus.errorOther.length}`)
  console.log(error)
}

const args = process.argv.slice(2);

// only fetch unsafe changes like new and deprecated integrations
// if the --unsafe CLI flag was provided
if (args.includes('--unsafe')) {
	await unsafeUpdateAllIntegrations();
} else {
	await safeUpdateExistingIntegrations();
}
console.log('DONE')