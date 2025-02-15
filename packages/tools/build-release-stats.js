/* eslint-disable require-atomic-updates */

const fetch = require('node-fetch');
const { writeFile, readFile, pathExists } = require('fs-extra');
const { dirname } = require('@joplin/lib/path-utils');
const markdownUtils = require('@joplin/lib/markdownUtils').default;
const yargParser = require('yargs-parser');
const { stripOffFrontMatter } = require('./website/utils/frontMatter');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));

const rootDir = dirname(dirname(__dirname));
const statsFilePath = `${rootDir}/readme/stats.md`;

function endsWith(str, suffix) {
	return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

function downloadCounts(release) {
	const output = {
		mac_count: 0,
		windows_count: 0,
		linux_count: 0,
	};

	for (let i = 0; i < release.assets.length; i++) {
		const asset = release.assets[i];
		const n = asset.name;
		if (endsWith(n, '-mac.zip') || endsWith(n, '.dmg')) {
			output.mac_count += asset.download_count;
		} else if (endsWith(n, '.AppImage') || endsWith(n, '.snap')) {
			output.linux_count += asset.download_count;
		} else if (endsWith(n, '.exe')) {
			output.windows_count += asset.download_count;
		}
	}

	output.total_count = output.mac_count + output.linux_count + output.windows_count;

	return output;
}

function createChangeLog(releases) {
	const output = [];

	output.push('# Joplin changelog');

	for (let i = 0; i < releases.length; i++) {
		const r = releases[i];
		const s = [];
		const preReleaseString = r.prerelease ? ' (Pre-release)' : '';
		s.push(`## ${r.tag_name}${preReleaseString} - ${r.published_at}`);
		s.push('');
		let body = r.body.replace(/#(\d+)/g, '[#$1](https://github.com/laurent22/joplin/issues/$1)');
		body = body.replace(/\(([0-9a-z]{7})\)/g, '([$1](https://github.com/laurent22/joplin/commit/$1))');
		s.push(body);
		output.push(s.join('\n'));
	}

	return output.join('\n\n');
}

async function main() {
	const argv = yargParser(process.argv);
	const types = argv.types ? argv.types.split(',') : ['stats', 'changelog'];
	const updateIntervalDays = argv.updateInterval ? argv.updateInterval : 0; // in days
	const updateInterval = updateIntervalDays * 86400000; // in days

	let updateStats = types.includes('stats');
	const updateChangelog = types.includes('changelog');

	if (updateStats && await pathExists(statsFilePath)) {
		const md = await readFile(statsFilePath, 'utf8');
		const info = stripOffFrontMatter(md);
		if (!info.updated) throw new Error('Missing front matter property: updated');

		if (info.updated.getTime() + updateInterval > Date.now()) {
			console.info(`Skipping stat update because the file (from ${info.updated.toString()}) is not older than ${updateIntervalDays} days`);
			updateStats = false;
		} else {
			console.info(`Proceeding with stat update because the file (from ${info.updated.toString()}) is older than ${updateIntervalDays} days`);
		}
	}

	console.info(`Building docs: updateChangelog: ${updateChangelog}; updateStats: ${updateStats}`);
	if (!updateStats && !updateChangelog) {
		console.info('Nothing to do.');
		return;
	}

	const rows = [];

	const totals = {
		windows_count: 0,
		mac_count: 0,
		linux_count: 0,
	};

	const processReleases = (releases) => {
		for (let i = 0; i < releases.length; i++) {
			const release = releases[i];
			if (!release.tag_name.match(/^v\d+\.\d+\.\d+$/)) continue;
			if (release.draft) continue;

			let row = {};
			row = Object.assign(row, downloadCounts(release));
			row.tag_name = `[${release.tag_name}](https://github.com/laurent22/joplin/releases/tag/${release.tag_name})`;
			row.published_at = release.published_at;
			row.body = release.body;
			row.prerelease = release.prerelease;

			totals.windows_count += row.windows_count;
			totals.mac_count += row.mac_count;
			totals.linux_count += row.linux_count;

			rows.push(row);
		}
	};

	console.info('Build stats: Downloading releases info...');

	const baseUrl = 'https://api.github.com/repos/laurent22/joplin/releases?page=';

	// GitHub release API has been broken for a few years now - a fetch for a
	// particular page may or may not return the page. So here we fetch the page
	// multiple times until we get it. If we don't get it after that, we can
	// assume there's really no page there. Without this hack, we get stuff like
	// this, where the changelog is partly cleared, then restored on next
	// update:
	//
	// - https://github.com/laurent22/joplin/commit/907422cefaeff52fe909278e40145812cc0d1303
	// - https://github.com/laurent22/joplin/commit/07535a494e5c700adce89835d1fb3dc077600240
	const multiFetch = async (url) => {
		for (let i = 0; i < 3; i++) {
			const response = await fetch(url);
			const output = await response.json();
			if (output && output.length) return output;
		}
		return null;
	};

	let pageNum = 1;
	while (true) {
		console.info(`Build stats: Page ${pageNum}`);
		const releases = await multiFetch(`${baseUrl}${pageNum}`);
		if (!releases || !releases.length) break;
		processReleases(releases);
		pageNum++;
	}

	if (updateChangelog) {
		console.info('Build stats: Updating changelog...');
		const changelogText = createChangeLog(rows);
		await writeFile(`${rootDir}/readme/changelog.md`, changelogText);
	}

	if (!updateStats) return;

	console.info('Build stats: Updating stats...');

	const grandTotal = totals.windows_count + totals.mac_count + totals.linux_count;
	totals.windows_percent = totals.windows_count / grandTotal;
	totals.mac_percent = totals.mac_count / grandTotal;
	totals.linux_percent = totals.linux_count / grandTotal;

	const formatter = new Intl.NumberFormat('en-US', { style: 'decimal' });

	const totalsMd = [
		{ name: 'Total Windows downloads', value: formatter.format(totals.windows_count) },
		{ name: 'Total macOs downloads', value: formatter.format(totals.mac_count) },
		{ name: 'Total Linux downloads', value: formatter.format(totals.linux_count) },
		{ name: 'Windows %', value: `${Math.round(totals.windows_percent * 100)}%` },
		{ name: 'macOS %', value: `${Math.round(totals.mac_percent * 100)}%` },
		{ name: 'Linux %', value: `${Math.round(totals.linux_percent * 100)}%` },
	];

	for (let i = 0; i < rows.length; i++) {
		rows[i].tag_name = rows[i].prerelease ? `${rows[i].tag_name} (p)` : rows[i].tag_name;
		rows[i].mac_count = formatter.format(rows[i].mac_count);
		rows[i].windows_count = formatter.format(rows[i].windows_count);
		rows[i].linux_count = formatter.format(rows[i].linux_count);
		rows[i].total_count = formatter.format(rows[i].total_count);
	}

	const statsMd = [
		'---',
		`updated: ${dayjs.utc().format()}`,
		'---',
		'',
		'# Joplin statistics',
		'',
		markdownUtils.createMarkdownTable([
			{ name: 'name', label: 'Name' },
			{ name: 'value', label: 'Value' },
		], totalsMd),
		'',
		'(p) Indicates pre-releases',
		'',
		markdownUtils.createMarkdownTable([
			{ name: 'tag_name', label: 'Version' },
			{ name: 'published_at', label: 'Date' },
			{ name: 'windows_count', label: 'Windows' },
			{ name: 'mac_count', label: 'macOS' },
			{ name: 'linux_count', label: 'Linux' },
			{ name: 'total_count', label: 'Total' },
		], rows),
	];

	const statsText = statsMd.join('\n');
	await writeFile(statsFilePath, statsText);
}

main().catch((error) => {
	console.error('Fatal error');
	console.error(error);
	process.exit(1);
});
