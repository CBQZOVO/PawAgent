import assert from 'node:assert/strict';
import { filesFromDataTransfer, hasDroppedFiles } from '../src/lib/dnd-files.ts';

function fakeFile(name: string, size = 10, type = 'text/plain'): File {
  return { name, size, type } as unknown as File;
}

function fakeFileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (ok: (f: File) => void) => ok(file),
  } as unknown as FileSystemFileEntry;
}

function fakeDirEntry(name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry {
  let idx = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok: (es: FileSystemEntry[]) => void) => ok(idx < batches.length ? batches[idx++] : []),
    }),
  } as unknown as FileSystemDirectoryEntry;
}

// 1. hasDroppedFiles
assert.equal(hasDroppedFiles({ types: ['Files'] } as unknown as DataTransfer), true);
assert.equal(hasDroppedFiles({ types: ['text/plain'] } as unknown as DataTransfer), false);
assert.equal(hasDroppedFiles(null), false);

// 2. 单文件优先保留原始 item.getAsFile()（保证 Electron webUtils.getPathForFile 可取路径）
{
  const nativeFile = fakeFile('report.pdf', 1024, 'application/pdf');
  const rebuiltFile = fakeFile('report.pdf', 1024, 'application/pdf');
  const dt = {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => nativeFile, webkitGetAsEntry: () => fakeFileEntry(rebuiltFile) }],
    files: [nativeFile],
  } as unknown as DataTransfer;
  const out = await filesFromDataTransfer(dt);
  assert.equal(out.length, 1);
  assert.equal(out[0], nativeFile, '单文件应保留原生 File 实例而非 entry.file() 副本');
}

// 3. 目录递归展开（多批 readEntries + 跳过隐藏文件与 node_modules/.git + 遵守数量上限）
{
  const dir = fakeDirEntry('project', [
    [
      fakeFileEntry(fakeFile('.DS_Store')),
      fakeDirEntry('.git', [[fakeFileEntry(fakeFile('HEAD'))]]),
      fakeDirEntry('node_modules', [[fakeFileEntry(fakeFile('pkg.js'))]]),
      fakeFileEntry(fakeFile('a.ts')),
    ],
    [
      fakeDirEntry('src', [[fakeFileEntry(fakeFile('b.ts')), fakeFileEntry(fakeFile('c.ts'))]]),
    ],
  ]);
  const dt = {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => fakeFile('project', 0, ''), webkitGetAsEntry: () => dir }],
    files: [],
  } as unknown as DataTransfer;
  const all = await filesFromDataTransfer(dt);
  assert.deepEqual(all.map((f) => f.name), ['a.ts', 'b.ts', 'c.ts']);

  const dir2 = fakeDirEntry('many', [[
    fakeFileEntry(fakeFile('1.txt')),
    fakeFileEntry(fakeFile('2.txt')),
    fakeFileEntry(fakeFile('3.txt')),
  ]]);
  const limited = await filesFromDataTransfer({
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => dir2 }],
    files: [],
  } as unknown as DataTransfer, 2);
  assert.deepEqual(limited.map((f) => f.name), ['1.txt', '2.txt']);
}

// 4. 无 webkitGetAsEntry 时退回 dt.files，过滤目录占位（type==='' && size===0）和隐藏文件
{
  const dt = {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => fakeFile('ok.txt') }],
    files: [fakeFile('folder', 0, ''), fakeFile('.env', 20, 'text/plain'), fakeFile('ok.txt', 20, 'text/plain')],
  } as unknown as DataTransfer;
  const out = await filesFromDataTransfer(dt);
  assert.deepEqual(out.map((f) => f.name), ['ok.txt']);
}

console.log('✓ dnd-files tests passed');
