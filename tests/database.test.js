const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {PGlite} = require('@electric-sql/pglite')
const {root} = require('./harness')

// Real PostgreSQL execution with a minimal fixture for existing application tables.
// This does not assert that the production schema or installed functions match.
test('PostgreSQL migration, permissions, pagination, abandon transitions, and quota ledger', async t => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'') $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;
      CREATE TABLE orders(id bigint PRIMARY KEY,owner_id text,runner_id text,runner_name text,
        title text,description text,service_name text,pickup_addr text,deliver_addr text,
        status text,created_at timestamptz DEFAULT now(),accepted_at timestamptz,
        runner_done_at timestamptz,finished_at timestamptz,deliver_images text[],takedown boolean DEFAULT false,
        reward numeric);
      CREATE TABLE order_hides(order_id bigint,user_id text);
      CREATE TABLE profiles(owner_id text PRIMARY KEY,role text,cert_status text,nickname text,owner_name text,balance numeric DEFAULT 0,is_admin boolean DEFAULT false);
      CREATE TABLE runner_applications(owner_id text,status text,real_name text,created_at timestamptz);
      CREATE TABLE feature_flags(flag_key text PRIMARY KEY,enabled boolean);
      CREATE TABLE faq_settings(id integer PRIMARY KEY,daily_limit integer,ai_enabled boolean,ai_model text);
      CREATE TABLE faq_items(id bigint PRIMARY KEY,enabled boolean);
      CREATE TABLE messages(id bigserial PRIMARY KEY,user_id text,kind text,title text,content text,ref_type text,ref_id bigint);
      CREATE TABLE wallet_records(user_id text,delta numeric,balance numeric,kind text,remark text);
      CREATE FUNCTION push_message(text,text,text,text,text,bigint) RETURNS bigint LANGUAGE sql AS
        $$ INSERT INTO messages(user_id,kind,title,content,ref_type,ref_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id $$;
      INSERT INTO profiles VALUES('owner','user','none','发布者','',0,true),
        ('2110332344891084801','user','approved','认证接单员','',0,false),('stranger','user','none','访客','',0,false);
      INSERT INTO feature_flags VALUES('ai_support',true);
      INSERT INTO faq_settings VALUES(1,2,true,'model');
      INSERT INTO faq_items VALUES(1,true);
    `)
    const notify=fs.readFileSync(path.join(root,'sql/add-notifications.sql'),'utf8')
    await db.exec(notify.slice(notify.indexOf('CREATE OR REPLACE FUNCTION public.trg_order_notify'),notify.indexOf('-- SQL-2')))
    const migration=fs.readFileSync(path.join(root,'sql/fix-order-support-workflows.sql'),'utf8')
    await db.exec(migration)
    await db.exec(migration) // replay must retain grants and not introduce overloads
    async function as(uid,sql,params=[]) {
      await db.exec('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid])
      await db.exec('SET ROLE authenticated')
      try {return (await db.query(sql,params)).rows} finally {await db.exec('RESET ROLE')}
    }
    async function raw(sql,params=[]) {return (await db.query(sql,params)).rows}

    await t.test('server filters before pagination, stabilizes ties, hides orders, and isolates accounts',async()=>{
      await db.exec(`INSERT INTO orders(id,owner_id,title,status,created_at)
        SELECT n,'owner','找快递','done',timestamptz '2026-10-01' FROM generate_series(1,45) n;
        INSERT INTO orders(id,owner_id,title,status) VALUES(90,'stranger','找快递','done'),(91,'owner','找快递','pending');
        INSERT INTO order_hides VALUES(45,'owner');`)
      const first=await as('owner',"SELECT * FROM list_my_orders_v2('publish',20,0,'done','快递')")
      const second=await as('owner',"SELECT * FROM list_my_orders_v2('publish',20,20,'done','快递')")
      assert.equal(first.length,20);assert.equal(second.length,20);assert.equal(Number(first[0].id),44)
      assert.equal(new Set([...first,...second].map(r=>r.id)).size,40)
      await assert.rejects(as('stranger',"SELECT * FROM list_my_orders_v2('admin',20,0,'all','')"),/admin only/)
      assert.equal((await as('owner',"SELECT * FROM list_my_orders_v2('admin',50,0,'all','')")).length,47)
      assert.equal((await as('stranger',"SELECT * FROM list_my_orders_v2('publish',20,0,'done','快递')")).length,1)
      assert.equal((await as('owner',"SELECT * FROM list_my_orders_v2('publish',20,0,'all','%')")).length,0)
    })

    await t.test('approved user can accept without switching role, owner/outsider cannot; notice is not duplicated',async()=>{
      await assert.rejects(as('stranger','SELECT * FROM accept_order(91)'),/接单员认证/)
      const rows=await as('2110332344891084801','SELECT * FROM accept_order(91)')
      assert.equal(rows[0].runner_id,'2110332344891084801')
      assert.equal((await raw("SELECT * FROM messages WHERE kind='order_accepted' AND ref_id=91")).length,1)
      assert.equal((await as('2110332344891084801','SELECT * FROM accept_order(91)')).length,0)
    })

    await t.test('abandon is assigned-runner only, idempotent and audited, and cannot undo delivery',async()=>{
      assert.equal((await as('stranger','SELECT * FROM abandon_order(91)')).length,0)
      assert.equal((await as('owner','SELECT * FROM abandon_order(91)')).length,0)
      const rows=await as('2110332344891084801','SELECT * FROM abandon_order(91)')
      assert.equal(rows[0].status,'pending');assert.equal(rows[0].runner_id,null);assert.equal(rows[0].accepted_at,null)
      assert.equal((await as('2110332344891084801','SELECT * FROM abandon_order(91)')).length,0)
      assert.equal((await raw('SELECT * FROM order_abandonments')).length,1)
      assert.equal((await raw("SELECT * FROM messages WHERE kind='order_abandoned'")).length,1)
      await as('2110332344891084801','SELECT * FROM accept_order(91)')
      await db.exec("UPDATE orders SET status='waiting_confirm' WHERE id=91")
      assert.equal((await as('2110332344891084801','SELECT * FROM abandon_order(91)')).length,0)
    })

    await t.test('reservations enforce account daily limit; failures refund and settlement is idempotent',async()=>{
      const a=(await as('owner','SELECT * FROM begin_support_ai()'))[0]
      const b=(await as('owner','SELECT * FROM begin_support_ai()'))[0]
      assert.equal(a.used,1);assert.equal(b.used,2)
      await assert.rejects(as('owner','SELECT * FROM begin_support_ai()'),/次数已用完/)
      await as('stranger','SELECT finish_support_ai($1,false)',[a.request_id])
      assert.equal((await as('owner','SELECT * FROM support_ai_usage()'))[0].used,2)
      await as('owner','SELECT finish_support_ai($1,false)',[a.request_id])
      assert.equal((await as('owner','SELECT * FROM support_ai_usage()'))[0].used,1)
      await as('owner','SELECT finish_support_ai($1,true)',[b.request_id])
      await as('owner','SELECT finish_support_ai($1,false)',[b.request_id])
      assert.equal((await as('owner','SELECT * FROM support_ai_usage()'))[0].used,1)
      const other=(await as('stranger','SELECT * FROM begin_support_ai()'))[0];assert.equal(other.used,1)
      await as('owner','SELECT rate_support_answer($1,NULL,true)',[b.request_id])
      await assert.rejects(as('stranger','SELECT rate_support_answer($1,NULL,true)',[b.request_id]),/回答不存在/)
      await as('owner',"SELECT rate_support_answer('',1,false)")
      assert.equal((await raw('SELECT * FROM support_answer_ratings')).length,2)
    })

    await t.test('expired reservations release quota and anonymous/direct-table access is denied',async()=>{
      await db.exec("UPDATE support_ai_requests SET created_at=now()-interval '5 minutes' WHERE state='pending'")
      assert.equal((await as('stranger','SELECT * FROM support_ai_usage()'))[0].used,0)
      await assert.rejects(as('owner','SELECT * FROM support_ai_requests'),/permission denied/)
      await assert.rejects(as('owner','SELECT * FROM order_abandonments'),/permission denied/)
      await assert.rejects(as('owner','SELECT * FROM support_answer_ratings'),/permission denied/)
      await db.exec('SET ROLE anon')
      try {await assert.rejects(db.query('SELECT * FROM begin_support_ai()'),/permission denied/)}
      finally {await db.exec('RESET ROLE')}
    })
  } finally {await db.close()}
})
