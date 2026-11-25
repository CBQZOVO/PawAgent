// 附件增删状态管理测试——覆盖粘贴/上传图片的删除、多文件删除、混合增删。
// 运行：pnpm --filter @paw/web test
import assert from 'node:assert/strict';
import type { Attachment } from '@paw/shared';
import { addAttachments, attachmentRefs, clearAttachments, removeAttachment } from '../src/lib/attachments.js';

const img = (name: string, size = 1000): Attachment => ({ name, size, mime: 'image/png', content: 'base64...', kind: 'image' });
const file = (name: string, size = 500): Attachment => ({ name, size, mime: 'text/markdown', content: '# content', kind: 'file' });
const names = (atts: Attachment[]) => atts.map((a) => a.name);

let pass = 0;
const test = (label: string, fn: () => void) => {
  try { fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

// 1. 粘贴一张图片 → 删除
test('粘贴1张图片 → 删除 → 空', () => {
  let a = addAttachments([], [img('IMG_8458.PNG')]);
  assert.deepEqual(names(a), ['IMG_8458.PNG']);
  a = removeAttachment(a, 0);
  assert.deepEqual(a, []);
});

// 2. 粘贴多张图片 → 删除其中一张（中间那张）
test('粘贴3张图片 → 删中间1张 → 剩2张且顺序正确', () => {
  let a = addAttachments([], [img('A.PNG'), img('B.PNG'), img('C.PNG')]);
  assert.deepEqual(names(a), ['A.PNG', 'B.PNG', 'C.PNG']);
  a = removeAttachment(a, 1);
  assert.deepEqual(names(a), ['A.PNG', 'C.PNG']);
  assert.equal(attachmentRefs(a), '@image#1:A.PNG @image#2:C.PNG'); // 编号重新连续
});

// 3. 粘贴多张图片 → 全部删除
test('粘贴3张图片 → 清空全部 → 空', () => {
  let a = addAttachments([], [img('A.PNG'), img('B.PNG'), img('C.PNG')]);
  a = clearAttachments();
  assert.deepEqual(a, []);
});

// 4. 上传多个文件 → 删除一个
test('上传3个文件 → 删第1个 → 剩2个', () => {
  let a = addAttachments([], [file('简历.md'), file('笔记.md'), file('配置.json')]);
  a = removeAttachment(a, 0);
  assert.deepEqual(names(a), ['笔记.md', '配置.json']);
  assert.equal(attachmentRefs(a), '@"笔记.md" @"配置.json"');
});

// 5. 上传多个文件 → 全部删除
test('上传3个文件 → 清空全部 → 空', () => {
  let a = addAttachments([], [file('a.md'), file('b.md'), file('c.md')]);
  a = clearAttachments();
  assert.deepEqual(a, []);
});

// 6. 同时粘贴图片和文件 → 混合增删
test('图片+文件混合 → 删中间 → 引用格式仍正确', () => {
  let a = addAttachments([], [img('IMG_1.PNG'), file('简历.md'), img('IMG_2.PNG'), file('数据.csv')]);
  assert.equal(attachmentRefs(a), '@image#1:IMG_1.PNG @"简历.md" @image#2:IMG_2.PNG @"数据.csv"');
  a = removeAttachment(a, 1); // 删掉简历.md
  assert.deepEqual(names(a), ['IMG_1.PNG', 'IMG_2.PNG', '数据.csv']);
  assert.equal(attachmentRefs(a), '@image#1:IMG_1.PNG @image#2:IMG_2.PNG @"数据.csv"');
  a = removeAttachment(a, 0); // 再删第一张图
  assert.equal(attachmentRefs(a), '@image#1:IMG_2.PNG @"数据.csv"');
});

// 附加：重复粘贴同一张图去重、上限10个、越界删除不崩
test('重复粘贴同名同大小 → 去重', () => {
  let a = addAttachments([], [img('A.PNG')]);
  a = addAttachments(a, [img('A.PNG')]);
  assert.equal(a.length, 1);
});

test('超过10个 → 截断为10', () => {
  const many = Array.from({ length: 15 }, (_, i) => file(`f${i}.md`));
  const a = addAttachments([], many);
  assert.equal(a.length, 10);
});

test('越界删除(-1 / 99)不崩溃', () => {
  const a = [img('A.PNG')];
  assert.equal(removeAttachment(a, -1), a);
  assert.equal(removeAttachment(a, 99), a);
});

console.log(`\n${pass}/9 通过`);
