const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.resolve(__dirname, '..')
function page(file, mocks = {}, globals = {}) {
  let spec
  const storage = new Map()
  const ui = { toast() {}, loading() {}, hideLoading() {}, confirm: () => Promise.resolve(false),
    available: () => true, getStorage: key => storage.get(key),
    setStorage: (key,value) => storage.set(key, JSON.parse(JSON.stringify(value))), removeStorage: key => storage.delete(key) }
  const api = { getErrorMessage: e => e.message || String(e), formatTime: x => x || '',
    getSession: () => Promise.resolve({user:{id:'2110332344891084800'}}), getProfile: () => Promise.resolve({role:'runner'}),
    getSupportUsage: () => Promise.resolve({used:0,daily_limit:20}), ...mocks.api }
  const deps = { ui: {...ui,...mocks.ui}, api, guard: {toastError(){}}, flags: {ensure:()=>Promise.resolve(),on:()=>true},
    services: {SERVICES:[],STATUS_TEXT:{},findService:()=>null}, campus:{BUILDINGS:[],FLOORS:[]},
    motion: {systemInfo:()=>({windowHeight:600,navTotalHeight:64}),stagger:x=>x,rootClass:()=>'',haptic(){}},
    moderation:{normalize:x=>String(x||'').toLowerCase(),scanText:()=>null,load:()=>Promise.resolve()}, ...mocks }
  deps.api = api
  deps.ui = {...ui,...mocks.ui}
  const timers = new Set()
  const context = vm.createContext({ console, Promise, Date, wx: {}, Page: x => {spec=x},
    require: name => deps[name.split('/').pop()] || {},
    setTimeout: (fn,ms) => {const id=setTimeout(fn,ms);id.unref();timers.add(id);return id},
    clearTimeout: id => {clearTimeout(id);timers.delete(id)}, ...globals })
  vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file})
  const patches=[]
  const instance = {...spec,data:JSON.parse(JSON.stringify(spec.data)),_alive:true,
    setData(patch,done) {
      patches.push(patch)
      for(const [key,value] of Object.entries(patch)) {
        const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.')
        let target=this.data
        parts.slice(0,-1).forEach(part=>{target=target[part]||(target[part]={})})
        target[parts.at(-1)]=value
      }
      if(done) done()
    }
  }
  return {instance,context,storage,patches,deps,cleanup:()=>timers.forEach(clearTimeout)}
}
function deferred() { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject} }
const flush = async () => {for(let i=0;i<12;i++)await Promise.resolve()}
module.exports={page,deferred,flush,root}
