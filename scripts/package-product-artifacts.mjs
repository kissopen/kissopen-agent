import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Offline distribution boundary. Never publishes, installs, or reloads.
const root = resolve(import.meta.dirname, '..');
const output = process.argv[2];
const targets = process.argv.slice(3);
if (!output || !targets.length || targets.some(target => !/^(darwin|linux)-(arm64|x64)$|^win32-x64$/.test(target))) {
    throw new Error('Usage: pnpm artifacts:product OUTPUT PLATFORM-ARCH [PLATFORM-ARCH ...]');
}
if (new Set(targets).size !== targets.length) throw new Error('Duplicate target');
const agent = JSON.parse(await readFile(join(root, 'packages/kissopen-agent/package.json'), 'utf8'));
const sdk = JSON.parse(await readFile(join(root, 'packages/kissopen-agent-client/package.json'), 'utf8'));
await readFile(join(root, 'packages/kissopen-agent-client/dist/index.js'));
const parent = resolve(output);
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(join(parent, '.packaging-'));
try {
    execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['pack', '--pack-destination', temporary], {
        cwd: join(root, 'packages/kissopen-agent-client'), stdio: 'inherit',
    });
    const sdkFile = `kissopen-kissopen-agent-client-${sdk.version}.tgz`;
    const describe = async file => {
        const bytes = await readFile(join(temporary, file));
        return { file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const binaries = [];
    for (const target of targets) {
        const [platform, arch] = target.split('-');
        if (platform !== process.platform) throw new Error(`Package ${target} on its native OS runner so its version can be verified.`);
        const file = `kissopen-agent-${target}${platform === 'win32' ? '.exe' : ''}`;
        const source = join(root, 'packages/kissopen-agent/dist/bin', file);
        const actualVersion = execFileSync(source, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
        if (actualVersion !== `KISSOPEN Agent ${agent.version}`) throw new Error(`Binary version mismatch: ${actualVersion}`);
        await copyFile(source, join(temporary, file));
        await chmod(join(temporary, file), 0o755);
        binaries.push({ platform, arch, ...await describe(file) });
    }
    const licensesFile = 'UPSTREAM_LICENSES.txt';
    const notices = [];
    async function collectNotices(directory, prefix = '') {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix + entry.name;
            if (entry.isDirectory() && !['node_modules', 'dist', 'target', '.git', '.local', '.context', 'vendor'].includes(entry.name)) {
                await collectNotices(join(directory, entry.name), relative + '/');
            } else if (entry.isFile() && /^(LICENSE(?:[.-].*)?|NOTICE(?:[.-].*)?|THIRD-PARTY-NOTICES\.md)$/.test(entry.name)) {
                notices.push(`===== ${relative} =====\n${await readFile(join(directory, entry.name), 'utf8')}\n`);
            }
        }
    }
    await collectNotices(root);
    await writeFile(join(temporary, licensesFile), notices.join('\n'));
    const manifest = {
        schemaVersion: 1,
        agentVersion: agent.version,
        sdk: { name: sdk.name, version: sdk.version, ...await describe(sdkFile) },
        binaries,
        licenses: await describe(licensesFile),
    };
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Refuse replacing an existing nonempty release directory.
    const destination = join(parent, agent.version);
    await rename(temporary, destination);
    console.log(`Prepared ${destination}; not published, installed, or reloaded.`);
} finally {
    await rm(temporary, { recursive: true, force: true });
}
