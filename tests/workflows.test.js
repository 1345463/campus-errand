const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const os = require('os')
const {page,deferred,flush,root} = require('./harness')
const event = data => ({currentTarget:{dataset:data}})

test('toast duration and a modal choice after 15 seconds are respected', async () => {
  let toast,modal,timers=0
  const context={module:{exports:{}},wx:{showToast:x=>{toast=x},showModal:x=>{modal=x}},console,
    setTimeout:()=>{timers++;return 1},clearTimeout(){}}
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/ui.js'),'utf8'),context)
  const ui=context.module.exports
  ui.toast({title:'提示',duration:2500});assert.equal(toast.duration,2500)
  let settled=false
  const promise=ui.confirm({title:'确认'}).then(x=>{settled=true;return x})
  await flush();assert.equal(settled,false);assert.equal(timers,0)
  modal.success({confirm:true});assert.equal(await promise,true)
})

test('release gate rejects each unsafe debug configuration', () => {
  const {assertReleaseConfig}=require('../tools/release-config')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campus-config-'))
  fs.mkdirSync(path.join(dir,'utils'))
  try {
    const cases=[{rememberPassword:true,autoLogin:false},{rememberPassword:false,autoLogin:true},
      {rememberPassword:false,autoLogin:false,presetAccount:{phone:'123',password:''}},
      {rememberPassword:false,autoLogin:false,presetAccount:{phone:'',password:'secret'}}]
    for(const config of cases) {
      fs.writeFileSync(path.join(dir,'utils/config.js'),'module.exports='+JSON.stringify(config))
      assert.throws(()=>assertReleaseConfig(dir),/发布被阻止/)
    }
    assertReleaseConfig(root)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('filtered order pagination uses server offsets and search survives status changes', async () => {
  const calls=[]
  const h=page('pages/orders/list.js',{api:{listMyOrders:(mode,limit,offset,status,keyword)=>{
    calls.push({mode,limit,offset,status,keyword})
    return Promise.resolve(Array.from({length:offset?2:20},(_,i)=>({id:offset+i+1,status,title:'测试'})))
  }}})
  const p=h.instance;p.data.status='done';p.data.searching=true;p.data.keyword='测试'
  await p.load();await p.loadMore()
  assert.equal(calls[1].offset,20);assert.equal(p.data.list.length,22)
  assert.equal(p.data.hasMore,false)
  p.switchStatus(event({key:'canceled'}));await flush()
  assert.equal(calls.at(-1).status,'canceled');assert.equal(calls.at(-1).keyword,'测试')
  assert.equal(p.data.searching,true);h.cleanup()
})

test('order list ignores old responses, including in-flight pagination', async () => {
  const calls=[]
  const h=page('pages/orders/list.js',{api:{listMyOrders:()=>{const d=deferred();calls.push(d);return d.promise}}})
  const p=h.instance
  const first=p.load();const second=p.load()
  calls[1].resolve([{id:2}]);await second;calls[0].resolve([{id:1}]);await first
  assert.equal(p.data.list[0].id,2)
  p.data.hasMore=true;const more=p.loadMore();const reset=p.load()
  calls[3].resolve([{id:4}]);await reset;calls[2].resolve([{id:3}]);await more
  assert.equal(p.data.list.length,1);assert.equal(p.data.list[0].id,4);h.cleanup()
})

test('returning to orders preserves loaded pages while refreshing without clearing', async () => {
  const d=deferred();let calls=0
  const h=page('pages/orders/list.js',{api:{listMyOrders:()=>{calls++;return calls===1?d.promise:Promise.resolve([{id:21}])}}})
  const p=h.instance;p.data.list=[{id:'existing'}];p._offset=40;p._loadedFilter='|publish|all|'
  const pending=p.load(true);assert.equal(p.data.list[0].id,'existing');assert.equal(p.data.loading,false)
  d.resolve(Array.from({length:20},(_,i)=>({id:i+1})));await pending
  assert.equal(calls,2);assert.equal(p.data.list.length,21);h.cleanup()
})

test('hall filter responses and pagination cannot overwrite newer choices', async () => {
  const calls=[]
  const h=page('pages/hall/index.js',{api:{listHallOrders:options=>{const d=deferred();calls.push({...d,options});return d.promise}}})
  const p=h.instance;p.checkRunner=()=>Promise.resolve(true);p.toCard=x=>x;p.data.filterOn=true
  const old=p.loadHall(true);await flush();p.data.sortKey='reward';const recent=p.loadHall(true);await flush()
  calls[1].resolve([{id:2,total:1}]);await recent;calls[0].resolve([{id:1,total:1}]);await old
  assert.equal(p.data.hall[0].id,2);assert.equal(calls[1].options.sort,'reward');h.cleanup()
})

test('anonymous detail has a login action without querying protected RPCs', async () => {
  const h=page('pages/order/detail.js',{api:{getSession:()=>Promise.resolve(null),getOrderDetail:()=>{throw Error('unexpected')}}})
  h.instance.data.id=1;await h.instance.load();assert.equal(h.instance.data.primary.key,'login');h.cleanup()
})

test('detail waits for flags and independent tail requests start together', async () => {
  const f=deferred(), image=deferred(),started=[]
  const h=page('pages/order/detail.js',{flags:{ensure:()=>f.promise,on:()=>true},api:{
    getOrderDetail:()=>Promise.resolve({id:1,status:'done',runner_id:'2110332344891084801',images:['asset:a'],deliver_images:['asset:b']}),
    isOrderHidden:()=>Promise.resolve(false),getOrderRelation:()=>Promise.resolve('owner'),
    getOrderImageUrls:paths=>{started.push(paths[0]);return image.promise},
    getMyReport:()=>{started.push('report');return Promise.resolve(null)},
    orderPeerCredit:()=>{started.push('credit');return Promise.resolve(null)},
    myOrderReviewState:()=>{started.push('review');return Promise.resolve(null)}
  }})
  const p=h.instance;p.onLoad({id:1});const pending=p.onShow();await flush();assert.equal(started.length,0)
  f.resolve();await flush();assert.equal(p.data.timelineOn,true)
  assert.deepEqual(started.sort(),['asset:a','asset:b','credit','report','review'].sort())
  image.resolve([]);await pending;h.cleanup()
})

test('delivery selection failure reaches fail handler and hides loading', async () => {
  let chosen,hidden=0,failed
  const h=page('pages/order/detail.js',{ui:{hideLoading:()=>hidden++},api:{uploadImage:()=>Promise.reject(Error('上传失败'))}},
    {wx:{chooseMedia:options=>{chosen=options}}})
  const p=h.instance;p.fail=e=>{failed=e.message};p.chooseDeliverPhotos();chosen.success({tempFiles:[{tempFilePath:'photo'}]});await flush()
  assert.equal(failed,'上传失败');assert.equal(hidden,1);assert.equal(p.data.uploading,false);h.cleanup()
})

test('delivery drafts survive confirmation expiry and can be removed without uploading again', async () => {
  const h=page('pages/order/detail.js');const p=h.instance
  p.data.photoOn=true;p.data.deliverPhotos=['asset:a'];p.data.deliverPreviews=['photo'];let rpc
  p.runRpc=(key,payload)=>{rpc={key,payload};return Promise.resolve()}
  p.doComplete();assert.equal(p.data.armKey,'complete');assert.equal(p._armTimer,undefined)
  p.clearArm();p.doComplete();await p.doComplete();assert.equal(rpc.payload[0],'asset:a')
  p.removeDeliverPhoto(event({index:0}));assert.equal(p.data.deliverPhotos.length,0);h.cleanup()
})

test('single-character FAQ matches and empty answers are rejected; failed history is excluded', () => {
  const h=page('pages/mine/support.js')
  const match=h.context.matchFaq,history=h.context.buildHistory
  const faq=[{question:'赏金多少钱',keywords:'钱 赏金',answer:'一元起'}]
  assert.equal(match('钱',faq),null);assert.equal(match('赏金',faq).answer,'一元起')
  assert.equal(match('赏金',[{...faq[0],answer:' \n '}]),null)
  assert.equal(history([{id:'a',kind:'ai',text:'失败',failed:true},{id:'b',kind:'ai',text:'回答'}],3,'').length,1)
  h.cleanup()
})

test('chat rows cannot inherit viewport-sized global page styles', () => {
  const css=fs.readFileSync(path.join(root,'app.wxss'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
  const pageClasses=new Set()
  for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if(!/min-height\s*:\s*(?:100|9\d)(?:s|d)?vh\b/.test(rule[2])) continue
    for(const selector of rule[1].matchAll(/\.([\w-]+)/g)) pageClasses.add(selector[1])
  }
  const template=fs.readFileSync(path.join(root,'pages/mine/support.wxml'),'utf8')
  const rowClass=template.match(/class="(msg-row[^\"]*)"/)[1]
  const directions=[...rowClass.matchAll(/'([\w-]+)'/g)].map(match=>match[1])
  for(const direction of directions) assert.equal(pageClasses.has(direction),false,
    'message class '+direction+' inherits full viewport min-height')
})

test('scroll measures current document before scrolling and keyboard changes update padding', () => {
  const order=[];let options
  const h=page('pages/mine/support.js',{}, {wx:{pageScrollTo:x=>{order.push('scroll');options=x}}})
  const p=h.instance;p.data.messages=[{text:'hello'}];p._docHeight=700
  p.measureDoc=done=>{order.push('measure');done(1200)};p.scrollToBottom()
  assert.deepEqual(order,['measure','scroll']);assert.equal(options.scrollTop,600)
  let measured=false;p.measureInput=()=>{measured=true};p.onKeyboardHeightChange({detail:{height:300}})
  assert.equal(measured,true);assert.equal(p.data.keyboardHeight,300);h.cleanup()
})

test('AI timeout works without AbortController; late stream callbacks cannot revive the answer', async () => {
  let timeout,delta;const finished=[];const answer=deferred()
  const h=page('pages/mine/support.js',{api:{beginSupportAi:()=>Promise.resolve({request_id:'r',used:1,daily_limit:20}),
    finishSupportAi:(id,success)=>{finished.push(success);return Promise.resolve()},
    llmChat:(model,messages,onDelta)=>{delta=onDelta;return answer.promise}}},
    {AbortController:undefined,setTimeout:(fn,ms)=>{if(ms===5000)timeout=fn;return ms},clearTimeout(){}})
  const p=h.instance;p.data.aiReady=true;p.data.settings={timeout_ms:5000};p.data.sending=true
  const pending=p.askAi('测试');await flush();timeout();await pending
  assert.equal(p.data.sending,false);assert.equal(p.data.messages.at(-1).failed,true);assert.deepEqual(finished,[false])
  const before=p.data.messages.at(-1).text;delta('迟到');answer.resolve('迟到');await flush()
  assert.equal(p.data.messages.at(-1).text,before);h.cleanup()
})

test('successful AI charges only on completion, uses incremental patches, and never renders an empty bubble', async () => {
  const answer=deferred(),finished=[];let delta
  const h=page('pages/mine/support.js',{api:{beginSupportAi:()=>Promise.resolve({request_id:'r',used:1,daily_limit:20}),
    finishSupportAi:(id,success)=>{finished.push(success);return Promise.resolve()},
    llmChat:(model,messages,onDelta)=>{delta=onDelta;return answer.promise}}})
  const p=h.instance;p.data.aiReady=true;p.data.sending=true
  const pending=p.askAi('测试');await flush();assert.equal(finished.length,0)
  delta('\n');p.updateMsg(p.data.messages[0].id,'\n',{pending:true});assert.ok(p.data.messages[0].text.trim())
  answer.resolve('有效回答');await pending;assert.deepEqual(finished,[true]);assert.equal(p.data.sending,false)
  assert.ok(h.patches.some(x=>Object.keys(x).includes('messages[0].text')));h.cleanup()
})

test('busy hot questions preserve input; empty transfer is blocked; long transfer retains marker and ticket', async () => {
  let content
  const h=page('pages/mine/support.js',{api:{submitUserFeedback:(kind,text)=>{content=text;return Promise.resolve({id:42})}}})
  const p=h.instance;p.data.input='正在输入';p.data.sending=true;p.onHotTap(event({q:'热门问题'}));assert.equal(p.data.input,'正在输入')
  p.submitHuman();await flush();assert.equal(content,undefined)
  p.data.messages=Array.from({length:6},(_,i)=>({role:i%2?'bot':'me',text:'长对话'.repeat(100)}))
  p.submitHuman();await flush();assert.ok(content.length<=500);assert.ok(content.endsWith('（由智能客服转人工）'))
  assert.equal(p.data.ticketId,'42');h.cleanup()
})

test('support boot does not duplicate welcome and saves scoped chat for login return', async () => {
  const h=page('pages/mine/support.js',{api:{listFaqItems:()=>Promise.resolve([]),getFaqSettings:()=>Promise.resolve({welcome:'欢迎'})}})
  const p=h.instance;await p.boot();await p.boot();assert.equal(p.data.messages.length,1)
  p.data.input='草稿';p.saveDraft(true)
  assert.equal(h.storage.get('supportLoginDraftV2').input,'草稿')
  assert.equal(h.storage.get('supportConversationV2:2110332344891084800').messages.length,1);h.cleanup()
})

test('missing selector API uses scroll fallback without throwing in input measurement', () => {
  let scrolled
  const h=page('pages/mine/support.js',{}, {wx:{pageScrollTo:options=>{scrolled=options.scrollTop}}})
  const p=h.instance;p.data.messages=[{text:'test'}]
  assert.doesNotThrow(()=>p.measureInput());p.scrollToBottom();assert.equal(scrolled,999999);h.cleanup()
})

test('order draft survives login, restores selected coupon, and does not leak into another account', async () => {
  const service={type:'other',name:'其他',fields:[{key:'description',type:'text'},{key:'reward',type:'reward'},{key:'contact',type:'text'}]}
  const h=page('pages/order/create.js',{services:{findService:()=>service},
    config:{minReward:1,maxReward:200,pickupShortcuts:[]},api:{listMyCoupons:()=>Promise.resolve([{code:'coupon',status:'unused',benefit_type:'deduct'}])}})
  const p=h.instance;p.onLoad({type:'other'});p.onShow();await flush()
  p.data.form.description='已填写的任务';p.data.coupons=[{code:'coupon'}];p.data.couponIndex=1;p.saveDraft(true)
  const draft=h.storage.get('orderDraftV1');assert.equal(draft.owner,'2110332344891084800');assert.equal(draft.forLogin,true)
  p.onLoad({type:'other'});p.onShow();await flush()
  assert.equal(p.data.form.description,'已填写的任务');assert.equal(p.data.couponIndex,1)
  h.deps.api.getSession=()=>Promise.resolve({user:{id:'different'}})
  p.onLoad({type:'other'});p.onShow();await flush();assert.equal(p.data.form.description,'')
  h.cleanup()
})

test('reward input keeps two decimals and invalid contact prevents order creation', () => {
  const toasts=[]
  const h=page('pages/order/create.js',{config:{minReward:1,maxReward:200},ui:{toast:x=>toasts.push(x.title)}})
  const p=h.instance;p.data.service={fields:[]};p.data.form={reward:'5',contact:'bad'}
  p.onInput({currentTarget:{dataset:{key:'reward'}},detail:{value:'5.123'}})
  assert.equal(p.data.form.reward,'5.12');p.submit();assert.match(toasts.at(-1),/手机号或微信号/);h.cleanup()
})

test('login redirect saves draft before switchTab and resumes only a local approved route', () => {
  const data=new Map();const actions=[]
  const ui={getStorage:key=>data.get(key),setStorage:(key,value)=>data.set(key,value),removeStorage:key=>data.delete(key)}
  const context={module:{exports:{}},require:()=>ui,Date,encodeURIComponent,
    getCurrentPages:()=>[{route:'pages/order/create',options:{type:'other',item:'快递'},saveDraft:flag=>actions.push('save:'+flag)}],
    wx:{switchTab:()=>actions.push('tab'),navigateTo:options=>actions.push(options.url)}}
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/login-return.js'),'utf8'),context)
  const back=context.module.exports;back.goLogin();back.resume()
  assert.equal(actions[0],'save:true');assert.equal(actions[1],'tab');assert.match(actions[2],/^\/pages\/order\/create\?type=other&item=/)
  data.set('loginReturnV1',{url:'https://example.com',at:Date.now()});back.resume();assert.equal(actions.length,3)
})

test('approved user in user role can accept from detail; duplicate clicks invoke one RPC', async () => {
  const profile=deferred();let accepted=0
  const h=page('pages/order/detail.js',{api:{getProfile:()=>profile.promise}})
  const p=h.instance;p.runRpc=()=>{accepted++;p.setData({busy:false});return Promise.resolve()}
  const pending=p.doAccept();p.doAccept();profile.resolve({role:'user',cert_status:'approved'});await pending
  assert.equal(accepted,1);h.cleanup()
})

test('FAQ 新增/编辑会打开表单并滚到表单位置', async () => {
  let scrolled=0
  const h=page('pages/admin/faq.js',{api:{}},{
    wx:{
      createSelectorQuery:()=>({
        select:()=>({boundingClientRect(){return this}}),
        selectViewport:()=>({scrollOffset(){return this}}),
        exec(cb){cb([{top:800},{scrollTop:120}])},
      }),
      pageScrollTo:opt=>{scrolled=opt.scrollTop},
    },
  })
  const p=h.instance
  p.data.list=[{id:7,category:'赏金',question:'赏金多少',answer:'1-200',keywords:'赏金',sortOrder:10,enabled:true,updatedText:''}]

  p.newFaq()
  assert.equal(p.data.editing,true)
  assert.equal(p.data.editingId,0)
  assert.equal(p.data.form.question,'')

  p.cancelEdit()
  p.editFaq(event({id:7}))
  assert.equal(p.data.editing,true)
  assert.equal(p.data.editingId,7)
  assert.equal(p.data.form.question,'赏金多少')

  // 表单是页面最后一张卡片，必须滚过去，否则用户以为"点了没反应"
  await new Promise(r=>setTimeout(r,120))
  assert.equal(scrolled,120+800-12)
  h.cleanup()
})
