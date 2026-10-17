// 服务分类与各服务对应的下单表单。
// 说明：原版的「乐跑代跑」属于代刷体测数据，未纳入；此处以「运动搭子」等合规服务替代。
// 「其它服务」这类自由填写的入口必须把红线写在眼前：
// 不得违反校纪校规与法律法规；接单员私下接、与平台提交信息不一致的任务，平台不认。
const COMPLIANCE_TIP =
  '不得填写违反校纪校规和法律法规的事项。接单员私下接受与平台提交的服务信息不同的任务，与本平台无关；例如：代跑校园跑、代课等。'

const COMMON = {
  time: {
    key: 'expect_time',
    label: '期望时间',
    type: 'text',
    placeholder: '例如：今天 18:00 前',
    required: false,
  },
  contact: {
    key: 'contact',
    label: '联系方式',
    type: 'text',
    placeholder: '手机号或微信号，接单后对方才能联系你',
    required: true,
  },
  images: {
    key: 'images',
    label: '相关图片',
    type: 'images',
    max: 5,
    required: false,
  },
  reward: {
    key: 'reward',
    label: '赏金（元）',
    type: 'reward',
    required: true,
  },
}

const SERVICES = [
  {
    type: 'express',
    name: '取快递',
    icon: '📦',
    tint: '#FFF0E4',
    hint: '快递柜、驿站代取送到宿舍',
    fields: [
      { key: 'pickup_addr', label: '取件地址', type: 'address', placeholder: '例如：进取楼快递柜', required: true },
      { key: 'deliver_addr', label: '送达地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      { key: 'description', label: '取件码 / 快递信息', type: 'textarea', placeholder: '取件码、手机号后四位、件数', required: true },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'buy',
    name: '帮我买',
    icon: '🛒',
    tint: '#FFF5E3',
    hint: '超市、食堂、水果店代买',
    fields: [
      { key: 'description', label: '想买什么', type: 'textarea', placeholder: '写清楚商品、规格、数量', required: true },
      { key: 'pickup_addr', label: '在哪买', type: 'address', placeholder: '例如：校园超市 / 二饭', required: true },
      { key: 'deliver_addr', label: '送到哪', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'milk',
    name: '取奶咖',
    icon: '🥤',
    tint: '#E4EEFF',
    hint: '奶茶咖啡代取，送到楼下',
    fields: [
      { key: 'pickup_addr', label: '门店', type: 'address', placeholder: '例如：南门蜜雪冰城', required: true },
      { key: 'deliver_addr', label: '送达地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      { key: 'description', label: '杯型 / 口味备注', type: 'textarea', placeholder: '少冰、三分糖、大杯', required: false },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'takeout',
    name: '拿外卖',
    icon: '🍜',
    tint: '#FFF5E3',
    hint: '外卖放久了会凉，帮你跑一趟',
    fields: [
      { key: 'pickup_addr', label: '取餐点', type: 'address', placeholder: '例如：进取楼外卖柜', required: true },
      { key: 'deliver_addr', label: '送达地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      { key: 'description', label: '取餐码 / 备注', type: 'textarea', placeholder: '取餐码、外卖平台、姓名尾号', required: false },
      { key: 'images', label: '取餐码截图', type: 'images', max: 5, required: false },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'print',
    name: '打印服务',
    icon: '🖨️',
    tint: '#E4EEFF',
    hint: '文档打印、复印、装订',
    fields: [
      { key: 'description', label: '打印要求', type: 'textarea', placeholder: '份数、单双面、黑白/彩印、装订方式', required: true },
      { key: 'images', label: '上传文件截图', type: 'images', max: 5, required: false },
      { key: 'pickup_addr', label: '打印店', type: 'address', placeholder: '例如：进取楼文印店', required: false },
      { key: 'deliver_addr', label: '送达地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'clean',
    name: '宿舍清洁',
    icon: '🧹',
    tint: '#E6F6EC',
    hint: '扫地拖地、倒垃圾、整理桌面',
    fields: [
      { key: 'pickup_addr', label: '宿舍地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      {
        key: 'tags',
        label: '清洁项目',
        type: 'tags',
        options: ['扫地拖地', '倒垃圾', '擦窗', '整理桌面', '洗漱台', '阳台'],
        required: false,
      },
      { key: 'description', label: '补充说明', type: 'textarea', placeholder: '需要特别注意的地方', required: false },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'queue',
    name: '代排队',
    icon: '🙋',
    tint: '#EAF1FF',
    hint: '取号排队、窗口办事代排',
    fields: [
      { key: 'pickup_addr', label: '排队地点', type: 'address', placeholder: '例如：行政楼 3 号窗口', required: true },
      { key: 'description', label: '排队事项', type: 'textarea', placeholder: '排什么队、大概需要多久、要不要代交材料', required: true },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'meal',
    name: '到店取餐',
    icon: '🍱',
    tint: '#FDECEC',
    hint: '食堂打包，热乎送到',
    fields: [
      { key: 'pickup_addr', label: '取餐地址', type: 'address', placeholder: '例如：第一食堂二楼兰州拉面', required: true },
      { key: 'deliver_addr', label: '送达地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      { key: 'expect_time', label: '预约送达时间', type: 'text', placeholder: '例如：12:10 前', required: false },
      COMMON.contact,
      { key: 'images', label: '取餐码截图（最多 5 张）', type: 'images', max: 5, required: false },
      COMMON.reward,
    ],
  },
  {
    type: 'luggage',
    name: '行李代搬',
    icon: '🧳',
    tint: '#FFF0E4',
    hint: '开学、搬宿舍、寄行李',
    fields: [
      { key: 'pickup_addr', label: '搬出地址', type: 'address', placeholder: '例如：进取楼 · 5层 · 12号', required: true },
      { key: 'deliver_addr', label: '搬入地址', type: 'address', placeholder: '例如：团结楼 · 3层 · 08号', required: true },
      {
        key: 'tags',
        label: '物品类型',
        type: 'tags',
        options: ['行李箱', '纸箱', '被褥', '电器', '其它'],
        required: false,
      },
      { key: 'description', label: '补充说明', type: 'textarea', placeholder: '大概几件、有没有重件', required: false },
      COMMON.time,
      COMMON.contact,
      COMMON.reward,
    ],
  },
  {
    type: 'other',
    name: '其它服务',
    icon: '✨',
    tint: '#E4EEFF',
    hint: '说清楚需求，总有人能帮',
    fields: [
      {
        key: 'description',
        label: '需要办什么事',
        type: 'textarea',
        placeholder: '请尽量写具体，便于同学判断是否接单',
        required: true,
        tip: COMPLIANCE_TIP,
      },
      { key: 'pickup_addr', label: '地点', type: 'address', placeholder: '在哪里办', required: false },
      COMMON.time,
      { key: 'gender_limit', label: '性别限制', type: 'gender', required: false },
      COMMON.contact,
      COMMON.reward,
    ],
  },
]

// 相机租赁：独立入口，下单时复用同一套订单流程
const RENTAL_SERVICE = {
  type: 'rental',
  name: '相机租赁',
  icon: '📷',
  tint: '#EAF1FF',
  hint: '日租起租，线下自提',
  fields: [
    { key: 'description', label: '租赁说明', type: 'textarea', placeholder: '机型、租几天、取还时间', required: true },
    { key: 'pickup_addr', label: '自提地点', type: 'address', placeholder: '例如：进取楼一楼大堂', required: false },
    { key: 'deliver_addr', label: '归还地点', type: 'address', placeholder: '例如：进取楼一楼大堂', required: false },
    COMMON.time,
    COMMON.contact,
    COMMON.reward,
  ],
}

const RENTAL_ITEMS = [
  { id: 'pocket4', name: '大疆 POCKET 4', price: 29.8, spec: '一英寸云台相机 · 4K' },
  { id: 'pocket3', name: '大疆 POCKET 3', price: 19.8, spec: '口袋云台 · Vlog 神器' },
  { id: 'mini99', name: '富士 Mini99', price: 15, spec: '拍立得 · 多档滤镜' },
  { id: 'wide400', name: '富士 instax WIDE 400', price: 18, spec: '宽幅拍立得 · 合影首选' },
  { id: 'mini12', name: '富士 Mini12', price: 12, spec: '入门拍立得 · 上手就会' },
]

// 送达地址（deliver_addr）统一标记为宿舍，前端渲染成「楼栋 → 楼层 → 宿舍号」三级选择器
function withDormPicker(list) {
  return list.map(function (service) {
    return Object.assign({}, service, {
      fields: service.fields.map(function (field) {
        if (field.key !== 'deliver_addr') return field
        return Object.assign({}, field, { kind: 'dorm', placeholder: '选择楼栋 · 楼层 · 宿舍号' })
      }),
    })
  })
}

const TAGGED_SERVICES = withDormPicker(SERVICES)
const TAGGED_RENTAL = withDormPicker([RENTAL_SERVICE])[0]

const STATUS_TEXT = {
  pending: '待接单',
  accepted: '进行中',
  waiting_confirm: '待发布方确认',
  done: '已完成',
  canceled: '已取消',
}

// 完成流程是两段式：接单员先标记送达，发布方确认后赏金才结算
const SETTLE_RULE_TEXT = '接单员标记送达后，需发布方确认，赏金才会打进接单员钱包'

function findService(type) {
  for (let i = 0; i < TAGGED_SERVICES.length; i += 1) {
    if (TAGGED_SERVICES[i].type === type) return TAGGED_SERVICES[i]
  }
  return type === TAGGED_RENTAL.type ? TAGGED_RENTAL : null
}

module.exports = {
  SERVICES: TAGGED_SERVICES,
  RENTAL_SERVICE: TAGGED_RENTAL,
  RENTAL_ITEMS: RENTAL_ITEMS,
  STATUS_TEXT: STATUS_TEXT,
  SETTLE_RULE_TEXT: SETTLE_RULE_TEXT,
  findService: findService,
}
