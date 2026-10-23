/* Development-only WXML/WeChat browser adapter. Never imports the production cloud SDK. */
;(async function () {
  const bundle = await fetch('/bundle.json').then(response => response.json())
  const root = document.getElementById('mp-root'), cache = {}, tabs = {}, stack = []
  const errors = [], logs = []
  let current, identity = 'owner', aiMode = 'normal', scheduled = false, rendering = false
  let renderCallbacks = [], nextOrder = 1000, nextTicket = 1, quota = 0, loading = false
  const reservations = new Map(), adminUsers = new Set(), app = {globalData:{logged:true}}
  const statuses = ['pending','accepted','waiting_confirm','done','canceled']
  const fixture = '/fixture.svg'
  const rows = Array.from({length:150}, (_, index) => ({
    id:index+1,owner_id:'test-owner',owner_name:'测试发布方',runner_id:index%5?'test-runner':null,
    runner_name:index%5?'测试接单员':'',title:'测试快递任务 ' + (index+1),service_type:'express',service_name:'取快递',
    description:'测试取件信息',pickup_addr:'大门快递柜',deliver_addr:'进取楼 · 5层 · 512号',
    reward:5,status:statuses[index%5],contact:'13800138000',expect_time:'1 小时内',images:[],tags:[],deliver_images:[],
    created_at:new Date(Date.now()-index*60000).toISOString(),accepted_at:index%5?new Date().toISOString():null,
    runner_done_at:index%5>1?new Date().toISOString():null,finished_at:index%5>2?new Date(Date.now()-8*86400000).toISOString():null,
    takedown:false,deliver_building:'进取楼',deliver_floor:'5层'
  }))
  for(let index=0;index<35;index++) rows.push({...rows[0],id:201+index,owner_id:'other-owner',owner_name:'其他测试发布方',
    title:'大厅任务 '+(index+1),status:index===1?'accepted':'pending',runner_id:index===1?'test-runner':null,
    reward:2+index%10,created_at:new Date(Date.now()-index*30000).toISOString()})
  const faq=[{id:1,question:'赏金最低多少钱',answer:'任务赏金最低 1 元，建议根据距离和任务量合理定价。',keywords:'赏金 最低 价格'},
    {id:2,question:'如何成为接单员',answer:'在「我的」提交接单员实名认证，审核通过后即可接单。',keywords:'认证 接单员'},
    {id:3,question:'订单如何取消',answer:'待接单任务可由发布方取消；接单员未提交送达前可以放弃接单。',keywords:'取消 放弃'}]
  const uid = () => identity==='guest' ? null : 'test-'+identity
  const copy = value => JSON.parse(JSON.stringify(value))
  function report() {
    const data=current?current.data:{}
    parent.postMessage({source:'campus-preview-runtime',identity,errors,logs,
      state:(current?current.route:'启动中')+'\n订单行数：'+(data.list?data.list.length:data.hall?data.hall.length:'—')+
      '\n筛选：'+(data.status||data.sortKey||'—')+'\n客服消息：'+(data.messages?data.messages.length:'—')+
      '\n回答状态：'+(data.sending?'回答中':'空闲')+'\n接口：隔离模拟，无线上请求'},location.origin)
  }
  function failure(error) { errors.push(error.message||String(error));report();console.error(error) }
  window.addEventListener('error',event=>failure(event.error||event.message))
  window.addEventListener('unhandledrejection',event=>{event.preventDefault();failure(event.reason)})
  function trace(name,args) {logs.push(name+(args?' '+JSON.stringify(args):''));report()}
  async function wait(ms=90) {await new Promise(resolve=>setTimeout(resolve,ms))}
  function auth() {if(!uid()){const e=new Error('请先登录');e.needLogin=true;throw e}}
  function order(id) {const row=rows.find(item=>item.id===Number(id));if(!row)throw Error('订单不存在');return row}
  const api = {
    getErrorMessage:error=>error.message||String(error),formatTime:value=>value?new Date(value).toLocaleString('zh-CN'):'',
    getSession:async()=>uid()?{user:{id:uid()}}:null,
    getProfile:async()=>uid()?{owner_id:uid(),nickname:identity==='runner'?'测试接单员':'测试发布方',
      role:identity==='runner'?'runner':'user',cert_status:'approved',is_admin:adminUsers.has(uid()),agreed_version:load('utils/agreement').VERSION}:null,
    activateAdmin:async code=>{
      auth()
      const result=await fetch('/preview-admin/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})}).then(response=>response.json())
      if(!result.ok)throw Error('后台密码不正确')
      adminUsers.add(uid());trace('activateAdmin',{mock:true,granted:true});return api.getProfile()
    },
    adminMyPerms:async()=>adminUsers.has(uid())?['super','hr','support','review','rental','print','settle','dispatch'].map(perm_key=>({perm_key})):[],
    adminDashboardStats:async()=>{auth();if(!adminUsers.has(uid()))throw Error('没有后台权限');return {can_super:true,can_review:true,can_rental:true,can_support:true,can_settle:true,today_orders:rows.length,total_orders:rows.length}},
    listMyOrders:async(mode,limit,offset,status,keyword)=>{
      auth();trace('listMyOrders',{mode,offset,status,keyword});await wait()
      const result=rows.filter(item=>!item.hidden&&(mode==='accept'?item.runner_id===uid():item.owner_id===uid())&&
        (status==='all'||item.status===status)&&(!keyword||[item.id,item.title,item.description,item.pickup_addr,item.deliver_addr].join(' ').includes(keyword)))
      return copy(result.slice(offset,offset+limit))
    },
    listHallOrders:async options=>{
      auth();trace('listHallOrders',options);await wait(options.sort==='reward'?180:60)
      const result=rows.filter(item=>item.status==='pending'&&!item.hidden&&
        (!options.serviceType||item.service_type===options.serviceType)&&(!options.building||item.deliver_building===options.building)&&(!options.floor||item.deliver_floor===options.floor))
      result.sort((a,b)=>options.sort==='reward'?b.reward-a.reward||b.id-a.id:b.id-a.id)
      return copy(result.slice(options.offset,options.offset+options.limit).map(item=>({...item,total:result.length})))
    },
    getOrderDetail:async id=>{auth();trace('getOrderDetail',{id});await wait();return copy(order(id))},
    getOrderRelation:async id=>{const item=order(id);return item.owner_id===uid()?'owner':item.runner_id===uid()?'runner':'none'},
    isOrderHidden:async id=>!!order(id).hidden,
    getOrderImageUrls:async images=>images.map(()=>({url:fixture})),orderPeerCredit:async()=>({score:4.8,score_count:12,done_count:15}),
    myOrderReviewState:async()=>({can_review:true}),getMyReport:async()=>null,
    listMyCoupons:async()=>[],listModerationWords:async()=>[],
    createOrder:async payload=>{auth();const row={...copy(payload),id:nextOrder++,owner_id:uid(),owner_name:'测试发布方',runner_id:null,status:'pending',created_at:new Date().toISOString()};rows.unshift(row);trace('createOrder',{id:row.id});return copy(row)},
    acceptOrder:async id=>{auth();const item=order(id);if(item.owner_id===uid())throw Error('不能接自己的任务');if(item.status!=='pending')throw Error('任务状态已变化');item.runner_id=uid();item.runner_name='测试接单员';item.status='accepted';item.accepted_at=new Date().toISOString();trace('acceptOrder',{id});return copy(item)},
    abandonOrder:async id=>{auth();const item=order(id);if(item.runner_id!==uid()||item.status!=='accepted')throw Error('当前状态不能放弃');item.runner_id=null;item.status='pending';item.accepted_at=null;trace('abandonOrder',{id});return copy(item)},
    completeOrder:async(id,images)=>{auth();const item=order(id);if(item.runner_id!==uid()||item.status!=='accepted')throw Error('当前状态不能提交送达');if(!images.length)throw Error('请先上传照片');item.status='waiting_confirm';item.deliver_images=images;item.runner_done_at=new Date().toISOString();trace('completeOrder',{id,photos:images.length});return copy(item)},
    cancelOrder:async id=>{const item=order(id);if(item.owner_id!==uid()||item.status!=='pending')throw Error('不能取消');item.status='canceled';item.finished_at=new Date().toISOString();return copy(item)},
    confirmOrderDone:async id=>{const item=order(id);if(item.owner_id!==uid()||item.status!=='waiting_confirm')throw Error('不能确认');item.status='done';return copy(item)},
    uploadImage:async()=>{await wait(140);trace('uploadImage',{fixture:true});return 'asset:test-'+Date.now()},
    hideMyOrder:async id=>{order(id).hidden=true},restoreMyOrder:async id=>{order(id).hidden=false},
    listMyHiddenOrders:async()=>copy(rows.filter(item=>item.hidden&&item.owner_id===uid())),
    listFaqItems:async()=>copy(faq),getFaqSettings:async()=>({ai_enabled:true,ai_model:'browser-fixture',daily_limit:20,timeout_ms:5000,history_turns:3,welcome:'你好，我是校园跑腿的智能助手，常见问题可以直接问我。'}),
    getSupportUsage:async()=>{auth();return {used:quota,daily_limit:20}},
    beginSupportAi:async()=>{auth();if(quota>=20)throw Error('今日次数已用完');const id='test-'+Date.now();reservations.set(id,'pending');trace('beginSupportAi',{id});return {request_id:id,used:quota+1,daily_limit:20}},
    finishSupportAi:async(id,success)=>{if(reservations.get(id)==='pending'){reservations.set(id,success?'success':'failed');if(success)quota++}trace('finishSupportAi',{success})},
    llmChat:async(model,messages,onDelta)=>{
      const mode=aiMode;trace('llmChat',{mode})
      if(mode==='timeout')return new Promise(()=>{})
      if(mode==='failure'){await wait(250);throw Error('模拟网络错误')}
      if(mode==='blank'){await wait(150);onDelta('\n');return '\n'}
      const answer='可以先在订单详情查看当前进度，并通过订单内的联系方式与对方沟通。如果仍无法解决，请点「转人工」，客服会根据具体情况协助处理。'
      for(let index=0;index<answer.length;index+=6){await wait(100);onDelta(answer.slice(0,index+6))}return answer
    },
    submitUserFeedback:async(kind,content)=>{auth();trace('submitUserFeedback',{length:content.length,marker:content.endsWith('（由智能客服转人工）')});return {id:nextTicket++}},
    rateSupportAnswer:async()=>{auth();trace('rateSupportAnswer')},submitSettleFeedback:async()=>({}),reportOrder:async()=>({})
  }
  const flags={ensure:async()=>{},load:async()=>{},on:()=>true,snapshot:()=>({})}
  function toast(options) {const el=document.getElementById('toast');el.textContent=options.title||String(options);clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.textContent=''},options.duration||2200)}
  function modal(options) {
    const host=document.getElementById('overlay');host.innerHTML=''
    const mask=document.createElement('div');mask.className='preview-modal';const panel=document.createElement('div');panel.className='preview-dialog'
    const title=document.createElement('h3');title.textContent=options.title;panel.append(title)
    const body=document.createElement('p');body.textContent=options.content||'';panel.append(body)
    for(const [label,confirmed] of [[options.cancelText||'取消',false],[options.confirmText||'确定',true]]){
      const button=document.createElement('button');button.textContent=label;button.onclick=()=>{host.innerHTML='';options.success?.({confirm:confirmed,cancel:!confirmed})};panel.append(button)
    }
    mask.append(panel);host.append(mask)
  }
  const wx={
    getStorageSync:key=>{try{return JSON.parse(localStorage.getItem('campus-browser:'+key)||'null')}catch{return null}},
    setStorageSync:(key,value)=>localStorage.setItem('campus-browser:'+key,JSON.stringify(value)),removeStorageSync:key=>localStorage.removeItem('campus-browser:'+key),
    getSystemInfoSync:()=>({windowWidth:innerWidth,windowHeight:innerHeight,statusBarHeight:20,platform:'devtools'}),
    getMenuButtonBoundingClientRect:()=>({top:24,height:32,width:87,right:innerWidth-10}),
    showToast:toast,showLoading:()=>{loading=true},hideLoading:()=>{loading=false},showModal:modal,
    pageScrollTo:options=>scrollTo({top:options.scrollTop,behavior:options.duration?'smooth':'instant'}),
    vibrateShort:()=>{},vibrateLong:()=>{},stopPullDownRefresh:()=>{},
    navigateTo:options=>{navigate(options.url);options.complete?.()},switchTab:options=>{navigate(options.url,true);options.complete?.()},
    navigateBack:()=>back(),
    chooseMedia:options=>modal({title:'模拟选择送达照片',content:'浏览器测试使用一张固定佐证图片，不调用设备相册。',confirmText:'选用测试图片',success:res=>{if(res.confirm)options.success({tempFiles:[{tempFilePath:fixture}]})}}),
    previewImage:options=>{const host=document.getElementById('overlay');host.innerHTML='<div class="preview-modal"><div class="preview-dialog"><img alt="送达照片预览"><button>关闭预览</button></div></div>';host.querySelector('img').src=options.current;host.querySelector('button').onclick=()=>{host.innerHTML=''}},
    createSelectorQuery:()=>{
      const selectors=[];const query={in:()=>query,select:selector=>{selectors.push(selector);return query},boundingClientRect:()=>query,
        exec:callback=>requestAnimationFrame(()=>callback(selectors.map(selector=>{const el=document.querySelector(selector);return el?el.getBoundingClientRect():null})))}
      return query
    }
  }
  function normalize(file) {const parts=[];for(const part of file.split('/')){if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part)}return parts.join('/')}
  function load(file) {
    if(!file.endsWith('.js'))file+='.js'
    if(file==='utils/api.js')return api
    if(file==='utils/flags.js')return flags
    if(file==='utils/cloud.js')return {cloud:{database:{rpc:async name=>{if(name!=='list_active_moderation_words')throw Error('未适配 RPC：'+name);return {data:[],error:null}}}}}
    if(cache[file])return cache[file].page||cache[file].exports
    if(!bundle.modules[file])throw Error('适配层未包含模块：'+file)
    const module={exports:{}};cache[file]=module
    const localRequire=name=>load(normalize(file.slice(0,file.lastIndexOf('/')+1)+name))
    const Page=spec=>{module.page=spec}
    new Function('require','module','exports','Page','wx','getApp','getCurrentPages',bundle.modules[file]+'\n//# sourceURL=/source/'+file)(localRequire,module,module.exports,Page,wx,()=>app,()=>stack)
    return module.page||module.exports
  }
  function patchData(target,patch) {
    for(const [key,value] of Object.entries(patch)){
      const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let obj=target
      for(const part of parts.slice(0,-1))obj=obj[part]||(obj[part]={})
      obj[parts.at(-1)]=value
    }
  }
  function schedule(done) {
    if(done)renderCallbacks.push(done)
    if(scheduled)return
    scheduled=true
    requestAnimationFrame(()=>{
      scheduled=false;render()
      const callbacks=renderCallbacks;renderCallbacks=[];callbacks.forEach(fn=>{try{fn()}catch(error){failure(error)}})
    })
  }
  function evaluate(expression,scope) {
    try{return new Function('scope','with(scope){return ('+expression+')}')(new Proxy(scope,{has:()=>true,get:(target,key)=>key===Symbol.unscopables?undefined:target[key]}))}
    catch{return undefined}
  }
  function value(text,scope) {
    const match=String(text||'').match(/^\s*{{([^{}]*)}}\s*$/)
    if(match)return evaluate(match[1],scope)
    return String(text||'').replace(/{{([\s\S]*?)}}/g,(_,expr)=>{const result=evaluate(expr,scope);return result==null?'':String(result)})
  }
  function makeTemplate(source) {
    const template=document.createElement('template')
    template.innerHTML=source.replace(/<([\w-]+)(\s[^<>]*?)?\s*\/>/g,(all,tag,attrs)=>tag==='input'?'<'+tag+(attrs||'')+'>':'<'+tag+(attrs||'')+'></'+tag+'>')
    return template.content
  }
  const templates=Object.fromEntries(Object.entries(bundle.templates).map(([key,source])=>[key,makeTemplate(source)]))
  function call(method,event) {
    if(!current||typeof current[method]!=='function'){failure(Error('缺少事件方法：'+method));return}
    try{const result=current[method](event);if(result?.catch)result.catch(failure)}catch(error){failure(error)}
  }
  function children(nodes,scope,key) {
    const fragment=document.createDocumentFragment();let chain=false,matched=false
    Array.from(nodes).forEach((node,index)=>{
      if(node.nodeType===3){const text=value(node.textContent,scope);if(text!=null&&String(text).trim())fragment.append(document.createTextNode(String(text)));return}
      if(node.nodeType!==1)return
      if(node.hasAttribute('wx:if')){chain=true;matched=!!value(node.getAttribute('wx:if'),scope);if(!matched)return}
      else if(node.hasAttribute('wx:elif')){if(!chain||matched)return;matched=!!value(node.getAttribute('wx:elif'),scope);if(!matched)return}
      else if(node.hasAttribute('wx:else')){if(!chain||matched)return;matched=true}
      else {chain=false;matched=false}
      fragment.append(build(node,scope,key+'-'+index))
    })
    return fragment
  }
  function build(node,scope,key,noLoop=false) {
    if(node.hasAttribute('wx:for')&&!noLoop){
      const frag=document.createDocumentFragment(),list=value(node.getAttribute('wx:for'),scope)||[]
      Array.from(list).forEach((item,index)=>frag.append(build(node,{...scope,[node.getAttribute('wx:for-item')||'item']:item,[node.getAttribute('wx:for-index')||'index']:index},key+'-'+index,true)))
      return frag
    }
    const tag=node.tagName.toLowerCase()
    if(tag==='block')return children(node.childNodes,scope,key)
    if(tag==='nav-bar'){
      const el=document.createElement('header');el.className='preview-nav'
      if(value(node.getAttribute('showback'),scope)){const button=document.createElement('button');button.textContent='‹';button.setAttribute('aria-label','返回');button.onclick=back;el.append(button)}
      const text=document.createElement('span');text.textContent=value(node.getAttribute('title'),scope);el.append(text);return el
    }
    const mapped={view:'div',text:'span','scroll-view':'div',image:'img','room-picker':'input',picker:'select'}[tag]||tag
    const el=document.createElement(mapped);el.dataset.mpNode=key
    const dataset={}
    for(const attribute of node.attributes){
      const name=attribute.name
      if(name.startsWith('wx:')||name.startsWith('bind')||name.startsWith('catch')||['value','range','fixed','hold-keyboard','adjust-position','auto-height'].includes(name))continue
      const resolved=value(attribute.value,scope)
      if(name.startsWith('data-')){dataset[name.slice(5)]=resolved;continue}
      if(name==='style')el.setAttribute(name,css(String(resolved||'')))
      else if(['class','id','placeholder','maxlength','src','title','type'].includes(name)&&resolved!=null)el.setAttribute(name,String(resolved))
    }
    const input=tag==='input'||tag==='textarea'||tag==='room-picker'
    if(input){
      el.value=value(node.getAttribute('value'),scope)||''
      const placeholder=value(node.getAttribute('placeholder'),scope)
      el.setAttribute('aria-label',placeholder||dataset.key||'输入')
      if(el.type==='digit')el.type='text'
      if(value(node.getAttribute('password'),scope))el.type='password'
      const handler=node.getAttribute('bindinput')||node.getAttribute('bind:change')
      if(handler)el.oninput=()=>{call(handler,{detail:{value:el.value},currentTarget:{dataset}});if(tag==='textarea')resizeTextarea(el)}
      const focus=node.getAttribute('bindfocus');if(focus)el.onfocus=()=>call(focus,{detail:{height:0},currentTarget:{dataset}})
      const confirm=node.getAttribute('bindconfirm');if(confirm)el.onkeydown=event=>{if(event.key==='Enter')call(confirm,{detail:{value:el.value},currentTarget:{dataset}})}
    } else if(tag==='picker'){
      const list=value(node.getAttribute('range'),scope)||[]
      list.forEach((label,index)=>{const option=document.createElement('option');option.textContent=label;option.value=index;el.append(option)})
      el.className='field-input';el.setAttribute('aria-label',dataset.key||'期望时间');const selectedText=String(value(node.textContent,scope)||'').trim();const selectedIndex=list.indexOf(selectedText);el.value=String(node.hasAttribute('value')?value(node.getAttribute('value'),scope):(selectedIndex<0?0:selectedIndex))
      el.onchange=()=>call(node.getAttribute('bindchange'),{detail:{value:Number(el.value)},currentTarget:{dataset}})
    } else if(tag!=='image')el.append(children(node.childNodes,scope,key))
    const tap=node.getAttribute('bindtap')||node.getAttribute('catchtap')
    if(tap){el.setAttribute('role','button');el.tabIndex=0;el.onclick=event=>{if(node.hasAttribute('catchtap'))event.stopPropagation();call(tap,{currentTarget:{dataset},detail:{}})}}
    return el
  }
  function css(source) {return source.replace(/(-?[\d.]+)rpx\b/g,(_,number)=>Number(number)*innerWidth/750+'px').replace(/\bpage\s*\{/g,'body {')}
  function resizeTextarea(el) {if(!el?.isConnected)return;el.style.height='auto';el.style.height=Math.min(el.scrollHeight,126)+'px'}
  function render() {
    if(!current||rendering)return
    rendering=true
    const active=document.activeElement,focusKey=active?.dataset.mpNode,selection=active?.selectionStart
    const currentValue=active&&['INPUT','TEXTAREA'].includes(active.tagName)?active.value:undefined
    document.getElementById('page-style').textContent=css(bundle.styles[current.route]||'')
    if(current._mockLogin){
      root.innerHTML='<div class="preview-login"><h2>模拟登录</h2><p>此处只测试登录返回与草稿恢复，不执行真实微信认证。</p><button id="test-login">模拟登录为发布方并返回</button></div>'
      document.getElementById('test-login').onclick=()=>{identity='owner';app.globalData.logged=true;load('utils/login-return').resume();report()}
    }else if(current.route==='pages/feedback/thread')root.innerHTML='<div class="preview-login"><h2>模拟工单 #'+current.options.id+'</h2><p>工单编号跳转成功。此页未连接真实客服。</p></div>'
    else root.replaceChildren(children(templates[current.route].childNodes,current.data,'root'))
    if(focusKey){const next=root.querySelector('[data-mp-node="'+focusKey+'"]');if(next){next.focus({preventScroll:true});if(currentValue!==undefined&&next.value===currentValue){try{next.setSelectionRange(selection,selection)}catch{}}}}
    root.querySelectorAll('textarea').forEach(resizeTextarea)
    rendering=false;report()
  }
  async function navigate(url,isTab=false) {
    const parsed=new URL(url,'http://preview'),route=parsed.pathname.replace(/^\//,''),options=Object.fromEntries(parsed.searchParams)
    if(!templates[route]&&!['pages/mine/index','pages/feedback/thread'].includes(route)){toast({title:'本次浏览器测试未包含该页面'});return}
    if(current){current._scroll=scrollY;current.onHide?.()}
    if(isTab){for(const page of stack){if(!tabs[page.route])page.onUnload?.()}stack.length=0}
    let page=isTab?tabs[route]:null
    if(!page){
      const useMockLogin=route==='pages/mine/index'&&!uid()
      const spec=useMockLogin?{data:{}}:templates[route]?load(route+'.js'):{data:{}}
      page={...spec,_mockLogin:useMockLogin,data:copy(spec.data),route,options,setData(patch,done){patchData(this.data,patch);if(this===current)schedule(done?()=>done.call(this):null)}}
      current=page;stack.push(page);if(['pages/orders/list','pages/hall/index'].includes(route))tabs[route]=page
      try{page.onLoad?.(options)}catch(error){failure(error)}
    }else {current=page;stack.push(page)}
    render();scrollTo(0,page._scroll||0)
    try{const result=page.onShow?.();if(result?.catch)result.catch(failure);page.onReady?.()}catch(error){failure(error)}
    history.replaceState(null,'','#/'+route+parsed.search);report()
  }
  function back() {if(stack.length<2){navigate('/pages/orders/list',true);return}current.onHide?.();current.onUnload?.();stack.pop();current=stack.at(-1);render();scrollTo(0,current._scroll||0);const result=current.onShow?.();result?.catch?.(failure);report()}
  window.addEventListener('scroll',()=>{current?.onPageScroll?.({scrollTop:scrollY});if(innerHeight+scrollY>=document.documentElement.scrollHeight-15)current?.onReachBottom?.()},{passive:true})
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.data.source!=='campus-preview-controls')return
    const {action,value}=event.data
    if(action==='navigate')navigate(value)
    if(action==='identity'){identity=value;app.globalData.logged=!!uid();const result=current.onShow?.();result?.catch?.(failure);report()}
    if(action==='ai'){aiMode=value;report()}
    if(action==='more')call('onReachBottom',{})
    if(action==='refresh')call('onPullDownRefresh',{})
    if(action==='back')back()
  })
  document.getElementById('app-style').textContent=css(bundle.appCss)
  await navigate('/pages/orders/list',true)
})().catch(error=>{document.getElementById('mp-root').textContent=error.stack||error.message})
