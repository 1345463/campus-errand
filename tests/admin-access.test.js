const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const path=require('path')
const {PGlite}=require('@electric-sql/pglite')
const {page,deferred,flush,root}=require('./harness')

test('mine exposes password entry to a signed-in user and dashboard to an administrator',()=>{
  const h=page('pages/mine/index.js');const p=h.instance;const routes=[];p.goPage=url=>routes.push(url)
  p.data.logged=true;p.goAdminEntry();assert.equal(routes.pop(),'/pages/mine/settings?admin=1')
  p.data.isAdmin=true;p.goAdminEntry();assert.equal(routes.pop(),'/pages/admin/dashboard');h.cleanup()
})

test('admin password failure never grants access and clears the submitted value',async()=>{
  let calls=0
  const h=page('pages/mine/settings.js',{api:{activateAdmin:()=>{calls++;return Promise.reject(Error('密码不正确'))}}})
  const p=h.instance;p.data.logged=true;p.data.adminCode='wrong'
  await p.submitAdminCode();assert.equal(calls,1);assert.equal(p.data.isAdmin,false)
  assert.equal(p.data.adminCode,'');assert.equal(p.data.adminSaving,false);assert.equal(p.data.adminError,'密码不正确');h.cleanup()
})

test('admin password success reloads permission cache and opens the dashboard only once',async()=>{
  const response=deferred();let calls=0,resets=0,navigations=0
  const h=page('pages/mine/settings.js',{api:{activateAdmin:()=>{calls++;return response.promise}},perms:{reset:()=>resets++}})
  const p=h.instance;p.data.logged=true;p.data.adminCode='test-code';p.goDashboard=()=>navigations++
  const pending=p.submitAdminCode();p.submitAdminCode();response.resolve({is_admin:true});await pending
  assert.equal(calls,1);assert.equal(resets,1);assert.equal(navigations,1);assert.equal(p.data.adminCode,'');assert.equal(p.data.isAdmin,true)
  p.data.adminCode='transient';p.onHide();assert.equal(p.data.adminCode,'');h.cleanup()
})

test('signed-out settings clear stale access state and dashboard does not depend on its own feature flag',async()=>{
  const h=page('pages/mine/settings.js',{api:{getSession:()=>Promise.resolve(null)}})
  const p=h.instance;p.data.isAdmin=true;p.data.adminCode='transient';p.data.adminPanelOpen=true
  await p.load();assert.equal(p.data.isAdmin,false);assert.equal(p.data.adminCode,'');assert.equal(p.data.adminPanelOpen,false);h.cleanup()
  const dashboard=page('pages/admin/dashboard.js',{flags:{ensure:()=>Promise.resolve(),on:()=>false},perms:{load:()=>Promise.resolve(),anyAdmin:()=>true}})
  let loaded=false;dashboard.instance.load=()=>{loaded=true;return Promise.resolve()}
  await dashboard.instance.checkAndLoad();assert.equal(loaded,true);dashboard.cleanup()
})

test('PostgreSQL admin password requires authentication, records failures, rate limits, and grants super',async t=>{
  const db=new PGlite()
  try{
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'') $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated;
      CREATE TABLE profiles(owner_id text PRIMARY KEY,is_admin boolean DEFAULT false,role text DEFAULT 'user');
      CREATE TABLE admin_grants(user_id text,perm_key text,granted_by text,PRIMARY KEY(user_id,perm_key));
      INSERT INTO profiles(owner_id) VALUES('tester'),('another');`)
    const sql=fs.readFileSync(path.join(root,'sql/restore-admin-password.sql'),'utf8')
    await db.exec(sql);await db.exec(sql)
    // Optional local verification of the requested configuration; the production
    // password is never embedded in client source or checked into this test.
    if(process.env.CAMPUS_ADMIN_TEST_CODE){
      const verified=await db.query("SELECT password_hash=encode(sha256(convert_to(password_salt||':'||$1,'UTF8')),'hex') AS ok FROM admin_password_settings",[process.env.CAMPUS_ADMIN_TEST_CODE])
      assert.equal(verified.rows[0].ok,true)
    }
    await db.exec("UPDATE admin_password_settings SET password_hash=encode(sha256(convert_to(password_salt||':fixture-correct-code','UTF8')),'hex')")
    async function as(uid,query,params=[]){
      await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]);await db.exec('SET ROLE authenticated')
      try{return(await db.query(query,params)).rows}finally{await db.exec('RESET ROLE')}
    }
    await t.test('wrong values commit attempts without changing privileges',async()=>{
      assert.equal((await as('tester',"SELECT * FROM activate_admin('wrong')")).length,0)
      assert.equal((await db.query("SELECT failures FROM admin_password_attempts WHERE user_id='tester'")).rows[0].failures,1)
      assert.equal((await db.query("SELECT is_admin FROM profiles WHERE owner_id='tester'")).rows[0].is_admin,false)
      assert.equal((await db.query('SELECT * FROM admin_grants')).rows.length,0)
    })
    await t.test('five failures lock the account window, which expires independently',async()=>{
      for(let i=0;i<4;i++)await as('tester',"SELECT * FROM activate_admin('wrong')")
      await assert.rejects(as('tester',"SELECT * FROM activate_admin('fixture-correct-code')"),/尝试次数过多/)
      await db.exec("UPDATE admin_password_attempts SET window_started=now()-interval '16 minutes' WHERE user_id='tester'")
      const profile=(await as('tester',"SELECT * FROM activate_admin('fixture-correct-code')"))[0]
      assert.equal(profile.is_admin,true);assert.equal(profile.role,'user')
      assert.equal((await db.query("SELECT * FROM admin_grants WHERE user_id='tester' AND perm_key='super'")).rows.length,1)
      assert.equal((await db.query('SELECT * FROM admin_password_audit')).rows.length,1)
      assert.equal((await db.query('SELECT * FROM admin_password_attempts')).rows.length,0)
    })
    await t.test('settings and counters are inaccessible directly, and anonymous callers are rejected',async()=>{
      await assert.rejects(as('tester','SELECT * FROM admin_password_settings'),/permission denied/)
      await assert.rejects(as('tester','SELECT * FROM admin_password_attempts'),/permission denied/)
      await assert.rejects(as('',"SELECT * FROM activate_admin('fixture-correct-code')"),/请先登录/)
      await db.exec('SET ROLE anon')
      try{await assert.rejects(db.query("SELECT * FROM activate_admin('fixture-correct-code')"),/permission denied/)}finally{await db.exec('RESET ROLE')}
    })
  }finally{await db.close()}
})
