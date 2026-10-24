const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {PGlite} = require('@electric-sql/pglite')
const {root} = require('./harness')

// 手机号绑定闸门 + 账号注销 6 个月保留期。
// 用真 PostgreSQL（PGlite）跑 sql/add-phone-and-deletion.sql，只建它引用到的表。
test('phone gate and 6-month account deletion retention', async t => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'') $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;

      CREATE TABLE profiles(id bigserial PRIMARY KEY, owner_id text NOT NULL,
        owner_name text, nickname text, avatar_url text, role text DEFAULT 'user',
        points integer DEFAULT 0, balance numeric DEFAULT 0, cert_status text DEFAULT 'none',
        is_admin boolean DEFAULT false, boost_until timestamptz,
        created_at timestamptz DEFAULT now());
      CREATE TABLE orders(id bigint PRIMARY KEY, owner_id text, runner_id text,
        owner_name text, runner_name text, contact text, title text,
        images text[], deliver_images text[], status text,
        created_at timestamptz DEFAULT now());
      CREATE TABLE addresses(id bigserial PRIMARY KEY, owner_id text, phone text);
      CREATE TABLE media_assets(id bigserial PRIMARY KEY, owner_id text, scope text, mime text, data text);
      CREATE TABLE messages(id bigserial PRIMARY KEY, user_id text, title text);
      CREATE TABLE admin_grants(user_id text, perm_key text, granted_by text,
        PRIMARY KEY(user_id, perm_key));
      CREATE TABLE runner_applications(id bigserial PRIMARY KEY, owner_id text, real_name text, status text);
      CREATE TABLE rental_requests(id bigserial PRIMARY KEY, owner_id text, real_name text,
        contact text, student_no text, status text);

      CREATE FUNCTION admin_is_any() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION admin_has_perm(text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

      INSERT INTO profiles(owner_id,nickname,owner_name) VALUES
        ('owner1','甲','甲'),('runner1','乙','乙'),('runner2','丙','丙'),('stranger','丁','丁');
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    `)
    await db.exec(fs.readFileSync(path.join(root,'sql/add-phone-and-deletion.sql'),'utf8'))

    async function as(uid,sql,params=[]) {
      await db.exec('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid])
      await db.exec('SET ROLE authenticated')
      try {return (await db.query(sql,params)).rows} finally {await db.exec('RESET ROLE')}
    }
    async function raw(sql,params=[]) {
      await db.exec('RESET ROLE')
      // 必须把会话里的 jwt claim 也清掉，否则触发器仍按上一个用户身份判断
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)")
      return (await db.query(sql,params)).rows
    }

    await t.test('未绑定手机号不能发单', async () => {
      await assert.rejects(
        () => as('owner1',"INSERT INTO orders(id,owner_id,title,status) VALUES(1,'owner1','取快递','pending')"),
        /请先绑定手机号/)
    })

    await t.test('手机号格式与唯一性', async () => {
      await assert.rejects(() => as('owner1',"SELECT * FROM bind_my_phone('123')"), /11 位手机号/)
      const ok = await as('owner1',"SELECT * FROM bind_my_phone('13800138000')")
      assert.equal(ok[0].bound,true)
      // 同一个号不能绑第二个账号
      await assert.rejects(
        () => as('runner1',"SELECT * FROM bind_my_phone('13800138000')"),
        /已绑定其他账号/)
      const st = await as('owner1',"SELECT * FROM my_phone_state()")
      assert.equal(st[0].bound,true)
      assert.equal(st[0].phone,'13800138000')
    })

    await t.test('换号 24 小时内只能一次', async () => {
      await assert.rejects(
        () => as('owner1',"SELECT * FROM bind_my_phone('13700137000')"),
        /24 小时内只能修改一次/)
    })

    await t.test('绑定后可以发单，未绑定的接不了单', async () => {
      await as('owner1',"INSERT INTO orders(id,owner_id,title,status) VALUES(1,'owner1','取快递','pending')")
      await assert.rejects(
        () => as('runner1',"UPDATE orders SET runner_id='runner1',status='accepted' WHERE id=1"),
        /请先绑定手机号后再接单/)
      await as('runner1',"SELECT * FROM bind_my_phone('13900139000')")
      const rows = await as('runner1',"UPDATE orders SET runner_id='runner1',status='accepted' WHERE id=1 RETURNING id")
      assert.equal(rows.length,1)
    })

    await t.test('参与方也要绑手机号才看得到联系方式', async () => {
      await raw("UPDATE orders SET contact='13800138000' WHERE id=1")
      // runner1 已绑定 → 看得到
      const a = await as('runner1',"SELECT contact FROM get_order_detail(1)")
      assert.equal(a[0].contact,'13800138000')
      // 强行塞一个未绑定的接单员（绕过触发器，模拟历史数据）
      await raw("UPDATE orders SET runner_id='runner2' WHERE id=1")
      const b = await as('runner2',"SELECT contact FROM get_order_detail(1)")
      assert.equal(b[0].contact,'')
    })

    await t.test('有未完成订单不能注销', async () => {
      await assert.rejects(
        () => as('owner1',"SELECT * FROM request_account_deletion('不想用了')"),
        /未完成的订单/)
    })

    await t.test('注销写入 6 个月保留期，期内可恢复', async () => {
      await raw("UPDATE orders SET status='done' WHERE id=1")
      const del = await as('owner1',"SELECT * FROM request_account_deletion('不想用了')")
      assert.equal(del[0].deleted,true)
      const days = Math.round((new Date(del[0].purge_after) - Date.now()) / 86400000)
      assert.ok(days >= 179 && days <= 183, 'purge_after 应约为 6 个月，实际 ' + days + ' 天')

      const st = await as('owner1',"SELECT * FROM my_account_state()")
      assert.equal(st[0].deleted,true)
      assert.equal(st[0].can_restore,true)

      const back = await as('owner1',"SELECT * FROM restore_my_account()")
      assert.equal(back[0].restored,true)
      const st2 = await as('owner1',"SELECT * FROM my_account_state()")
      assert.equal(st2[0].deleted,false)
    })

    await t.test('保留期内手机号不能被别的账号占用', async () => {
      await as('owner1',"SELECT * FROM request_account_deletion('再注销一次')")
      await assert.rejects(
        () => as('stranger',"SELECT * FROM bind_my_phone('13800138000')"),
        /已绑定其他账号/)
    })

    await t.test('满 6 个月清理 PII，手机号释放', async () => {
      await raw("UPDATE account_deletions SET purge_after = now() - interval '1 day' WHERE owner_id='owner1' AND purged_at IS NULL")
      const p = await as('owner1',"SELECT * FROM purge_my_account_if_due()")
      assert.equal(p[0].purged,true)

      const prof = await raw("SELECT nickname,owner_name,avatar_url,points FROM profiles WHERE owner_id='owner1'")
      assert.equal(prof[0].nickname,'已注销用户')
      assert.equal(prof[0].owner_name,'已注销用户')
      assert.equal(prof[0].avatar_url,'')
      assert.equal(Number(prof[0].points),0)

      const phone = await raw("SELECT count(*)::int AS n FROM profile_phones WHERE owner_id='owner1'")
      assert.equal(phone[0].n,0)
      const ord = await raw("SELECT contact,owner_name,images FROM orders WHERE id=1")
      assert.equal(ord[0].contact,'')
      assert.equal(ord[0].owner_name,'已注销用户')
      assert.equal(ord[0].images.length,0)

      // 手机号释放后可以被新账号绑定
      const rebind = await as('stranger',"SELECT * FROM bind_my_phone('13800138000')")
      assert.equal(rebind[0].bound,true)

      const st = await as('owner1',"SELECT * FROM my_account_state()")
      assert.equal(st[0].deleted,false)
    })

    await t.test('清理后不能再恢复', async () => {
      await assert.rejects(() => as('owner1',"SELECT * FROM restore_my_account()"), /未注销/)
    })
  } finally {
    await db.close()
  }
})
