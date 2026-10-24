const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {PGlite} = require('@electric-sql/pglite')
const {root} = require('./harness')

// 图片归属触发器：images 是发布方的、deliver_images 是接单员的，
// 同一行会被两个人分别更新。触发器只能校验「本次改动的那一列」，
// 否则接单员放弃接单 / 提交送达都会被判成越权。
test('order asset trigger only checks the column being changed', async t => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'') $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;

      CREATE TABLE orders(id bigint PRIMARY KEY, owner_id text, runner_id text,
        status text, images text[], deliver_images text[]);
      CREATE TABLE media_assets(id bigint PRIMARY KEY, owner_id text, scope text);

      INSERT INTO media_assets VALUES (1,'owner','order'),(2,'runner','deliver'),(3,'other','order');
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    `)
    await db.exec(fs.readFileSync(path.join(root,'sql/fix-order-asset-trigger.sql'),'utf8'))
    await db.exec(`
      CREATE TRIGGER orders_assert_assets_owned
        BEFORE INSERT OR UPDATE OF images, deliver_images ON public.orders
        FOR EACH ROW EXECUTE FUNCTION public.assert_order_assets_owned();
    `)

    async function as(uid,sql,params=[]) {
      await db.exec('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid])
      await db.exec('SET ROLE authenticated')
      try {return (await db.query(sql,params)).rows} finally {await db.exec('RESET ROLE')}
    }
    async function raw(sql,params=[]) {
      await db.exec('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)")
      return (await db.query(sql,params)).rows
    }

    await t.test('发布方建单：只有自己的图能进', async () => {
      const rows = await as('owner',"INSERT INTO orders(id,owner_id,status,images) VALUES(1,'owner','pending',ARRAY['asset:1']::text[]) RETURNING id")
      assert.equal(rows.length,1)
      await assert.rejects(
        () => as('owner',"INSERT INTO orders(id,owner_id,status,images) VALUES(2,'owner','pending',ARRAY['asset:3']::text[])"),
        /图片不属于当前账号/)
    })

    await t.test('接单员放弃接单：清空佐证不校验发布方的任务图', async () => {
      await raw("UPDATE orders SET runner_id='runner', status='accepted', deliver_images=ARRAY['asset:2']::text[] WHERE id=1")
      const rows = await as('runner',"UPDATE orders SET status='pending', runner_id=NULL, deliver_images=ARRAY[]::text[] WHERE id=1 RETURNING id")
      assert.equal(rows.length,1)
    })

    await t.test('接单员提交送达：写自己的佐证可以过', async () => {
      await raw("UPDATE orders SET runner_id='runner', status='accepted' WHERE id=1")
      const rows = await as('runner',"UPDATE orders SET status='waiting_confirm', deliver_images=ARRAY['asset:2']::text[] WHERE id=1 RETURNING id")
      assert.equal(rows.length,1)
    })

    await t.test('接单员不能把别人的图塞进佐证', async () => {
      await assert.rejects(
        () => as('runner',"UPDATE orders SET deliver_images=ARRAY['asset:3']::text[] WHERE id=1"),
        /图片不属于当前账号/)
    })

    await t.test('只改状态不动图片列时不触发校验', async () => {
      const rows = await as('owner',"UPDATE orders SET status='done' WHERE id=1 RETURNING id")
      assert.equal(rows.length,1)
    })
  } finally {
    await db.close()
  }
})
