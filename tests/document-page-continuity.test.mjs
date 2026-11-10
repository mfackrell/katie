import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedBlockPages } from '../scripts/document-page-continuity.mjs';

test('repeated heading words are located by source order rather than ambiguous substring matches',()=>{
  assert.deepEqual(orderedBlockPages(['EducationServices','Record','Education','Degree'],
    ['EducationServicesRecord','EducationDegree']),[[1],[1],[2],[2]]);
  assert.deepEqual(orderedBlockPages(['Same','Same'],['Same','Same']),[[1],[2]]);
});
test('actual split blocks expose every physical page without weakening continuity',()=>{
  assert.deepEqual(orderedBlockPages(['Heading','SupportingText'],['HeadingSupport','ingText']),[[1],[1,2]]);
});
test('missing, altered, duplicated or reordered rendered glyphs must fail mapping',()=>{
  for(const pages of [['AB'],['ACB'],['ABB'],['BA']])
    assert.throws(()=>orderedBlockPages(['AB','C'],pages),/exact ordered/);
});
test('empty or invalid source and page evidence fails closed',()=>{
  assert.throws(()=>orderedBlockPages([],['A']),/Missing/);
  assert.throws(()=>orderedBlockPages(['A'],['']),/Missing/);
  assert.throws(()=>orderedBlockPages(['A'],[1]),/Missing/);
});
