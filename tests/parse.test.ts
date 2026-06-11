import { describe, expect, it } from 'vitest';
import { extractJson, parseDiscussionOutput, parseReviewOutput } from '../src/parse.js';

describe('extractJson', () => {
  it('解析裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('解析 markdown 代码块包裹的 JSON', () => {
    expect(extractJson('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ a: 1 });
  });

  it('解析夹杂说明文字的 JSON（取第一个配平对象）', () => {
    expect(extractJson('我的结论如下：{"a":{"b":"x}y"}} 完毕')).toEqual({ a: { b: 'x}y' } });
  });

  it('无 JSON 时抛错', () => {
    expect(() => extractJson('没有任何对象')).toThrow('未找到 JSON');
  });

  it('JSON 不完整时抛错', () => {
    expect(() => extractJson('{"a":')).toThrow();
  });

  it('裸 JSON 的字符串值内嵌 ```js 代码块时不被误抓', () => {
    const json = JSON.stringify({ findings: [{ suggestion: '示例：\n```js\nconst x = 1;\n```\n如上' }] });
    expect(extractJson(json)).toEqual({ findings: [{ suggestion: '示例：\n```js\nconst x = 1;\n```\n如上' }] });
  });
});

describe('parseReviewOutput', () => {
  it('解析合法 findings', () => {
    const text = JSON.stringify({
      findings: [{
        id: 'f1', file: 'src/a.ts', line: 10, severity: 'major',
        title: '空指针', description: 'x 可能为 null', suggestion: '加判空',
      }],
    });
    const out = parseReviewOutput(text);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe('major');
  });

  it('severity 非法时抛出含字段信息的错误', () => {
    const text = JSON.stringify({
      findings: [{ id: 'f1', file: 'a', line: null, severity: 'huge', title: 't', description: '', suggestion: '' }],
    });
    expect(() => parseReviewOutput(text)).toThrow(/severity/);
  });

  it('line 为 null 时合法', () => {
    const text = JSON.stringify({
      findings: [{ id: 'f1', file: 'a', line: null, severity: 'nit', title: 't', description: '', suggestion: '' }],
    });
    expect(parseReviewOutput(text).findings[0].line).toBeNull();
  });

  it('line 为 0 时抛错（必须为正整数）', () => {
    const text = JSON.stringify({
      findings: [{ id: 'f1', file: 'a', line: 0, severity: 'nit', title: 't', description: '', suggestion: '' }],
    });
    expect(() => parseReviewOutput(text)).toThrow(/findings\.0\.line/);
  });

  it('findings 为空数组时合法', () => {
    expect(parseReviewOutput('{"findings": []}').findings).toEqual([]);
  });

  it('真实 codex 格式：自动补全 id/title，规范化 severity', () => {
    // codex 真实输出不含 id/title，severity 用 "warning" 而非 "major"
    const text = JSON.stringify({
      findings: [{
        severity: 'warning',
        file: 'calc.js',
        line: 5,
        description: 'parseInt 缺少 radix 参数，可能解析非十进制数',
        why: '可能引发意外行为',
        suggestion: '使用 parseInt(s, 10)',
      }],
    });
    const out = parseReviewOutput(text);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.id).toBe('f1');
    expect(f.title).toBeTruthy();
    expect(f.severity).toBe('major'); // "warning" -> "major"
    expect(f.suggestion).toBe('使用 parseInt(s, 10)');
  });
});

describe('parseDiscussionOutput', () => {
  it('解析合法 responses', () => {
    const text = '```json\n' + JSON.stringify({
      responses: [{ findingId: 'f1', stance: 'agree', comment: '同意', revisedSuggestion: null }],
    }) + '\n```';
    const out = parseDiscussionOutput(text);
    expect(out.responses[0].stance).toBe('agree');
  });

  it('responses 为空数组时合法', () => {
    expect(parseDiscussionOutput('{"responses": []}').responses).toEqual([]);
  });

  it('stance 非法时抛出含字段信息的错误', () => {
    const text = JSON.stringify({
      responses: [{ findingId: 'f1', stance: 'maybe', comment: '', revisedSuggestion: null }],
    });
    expect(() => parseDiscussionOutput(text)).toThrow(/stance/);
  });
});
