import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap} from '../src/bootstrap.mjs';

test('bootstrap can resume partial schema creation and leaves custom sales fields alone', async () => {
  const objects = new Map();
  let mutations = 0;
  const api = {request:async (path, method='GET', body) => {
    if (path.startsWith('metadata/objects?')) return {data:[...objects.values()],pageInfo:{hasNextPage:false}};
    if (path==='metadata/objects' && method==='POST') {
      mutations++;
      const object={...body,id:body.nameSingular,fields:[{name:'name'},{name:'salesStage'}]};
      objects.set(object.id,object); return object;
    }
    if (path.startsWith('metadata/objects/')) return objects.get(path.split('/').at(-1));
    if (path==='metadata/fields' && method==='POST') {
      mutations++;objects.get(body.objectMetadataId).fields.push(body);return body;
    }
    throw new Error('unexpected endpoint');
  }};
  await bootstrap(api);
  const firstPass=mutations;
  assert.equal(objects.size,3);
  assert.ok(firstPass>3);
  await bootstrap(api);
  assert.equal(mutations,firstPass);
  for(const object of objects.values()) assert.ok(object.fields.find(field=>field.name==='salesStage'));
});
