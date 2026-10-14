const campus = require('../../utils/campus')
const ui = require('../../utils/ui')

const OTHER = '其他'

function withOther(list) {
  return list.concat([OTHER])
}

function otherIndex(list) {
  return list.length // 追加「其他」后的下标
}

Component({
  properties: {
    value: {
      type: String,
      value: '',
    },
    placeholder: {
      type: String,
      value: '选择楼栋 / 楼层 / 宿舍号',
    },
  },

  data: {
    visible: false,
    idx: [0, 0, 0],
    custom: ['', '', ''],
    buildings: withOther(campus.BUILDINGS),
    floors: withOther(campus.FLOORS),
    rooms: withOther(campus.ROOMS),
    other0: false,
    other1: false,
    other2: false,
    colHeight: 440,
  },

  observers: {
    value: function (value) {
      this.applyValue(value)
    },
  },

  methods: {
    applyValue: function (value) {
      const lists = [this.data.buildings, this.data.floors, this.data.rooms]
      const parts = String(value || '')
        .split('·')
        .map(function (item) {
          return String(item || '').trim()
        })
      const idx = [0, 0, 0]
      const custom = ['', '', '']
      for (let i = 0; i < 3; i += 1) {
        const part = parts[i] || ''
        if (!part) {
          idx[i] = 0
          custom[i] = ''
          continue
        }
        const found = lists[i].indexOf(part)
        if (found >= 0) {
          idx[i] = found
          custom[i] = ''
        } else {
          // 不是预设项，说明是用户手写的「其他」
          idx[i] = otherIndex(campus[i === 0 ? 'BUILDINGS' : i === 1 ? 'FLOORS' : 'ROOMS'])
          custom[i] = part
        }
      }
      this.setData({ idx: idx, custom: custom }, this.syncFlags.bind(this))
    },

    syncFlags: function () {
      const b = otherIndex(campus.BUILDINGS)
      const f = otherIndex(campus.FLOORS)
      const r = otherIndex(campus.ROOMS)
      const idx = this.data.idx
      this.setData({ other0: idx[0] === b, other1: idx[1] === f, other2: idx[2] === r })
    },

    open: function () {
      this.setData({ visible: true })
    },

    close: function () {
      this.setData({ visible: false })
    },

    // 三列各自点击选中。不用原生 picker-view —— 它在 H5 预览里渲染不出三列
    pick: function (event) {
      const col = Number(event.currentTarget.dataset.col)
      const index = Number(event.currentTarget.dataset.i)
      const next = this.data.idx.slice()
      next[col] = index
      // 从「其他」切回预设项时清掉对应输入框，避免留下旧内容
      const custom = this.data.custom.slice()
      const b = otherIndex(campus.BUILDINGS)
      const f = otherIndex(campus.FLOORS)
      const r = otherIndex(campus.ROOMS)
      const limits = [b, f, r]
      if (next[col] !== limits[col]) custom[col] = ''
      this.setData({ idx: next, custom: custom }, this.syncFlags.bind(this))
    },

    onCustomInput: function (event) {
      const col = Number(event.currentTarget.dataset.col)
      const custom = this.data.custom.slice()
      custom[col] = event.detail.value || ''
      this.setData({ custom: custom })
    },

    confirm: function () {
      const idx = this.data.idx
      const custom = this.data.custom
      const b = otherIndex(campus.BUILDINGS)
      const f = otherIndex(campus.FLOORS)
      const r = otherIndex(campus.ROOMS)
      const limits = [b, f, r]
      const names = ['楼栋', '楼层', '宿舍号']

      for (let i = 0; i < 3; i += 1) {
        if (idx[i] === limits[i] && !String(custom[i] || '').trim()) {
          ui.toast({ title: '请填写「其他' + names[i] + '」的具体内容', icon: 'none' })
          return
        }
      }

      const parts = []
      const lists = [this.data.buildings, this.data.floors, this.data.rooms]
      for (let i = 0; i < 3; i += 1) {
        if (idx[i] === limits[i]) parts.push(String(custom[i] || '').trim())
        else parts.push(lists[i][idx[i]])
      }
      const text = parts.filter(Boolean).join(' · ')
      this.setData({ visible: false })
      this.triggerEvent('change', { value: text })
    },

    noop: function () {},
  },
})
