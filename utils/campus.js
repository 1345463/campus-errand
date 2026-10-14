// 广东邮电职业技术学院 · 宿舍楼栋配置
// 收货地址统一走「楼栋 → 楼层 → 宿舍号」三级选择，避免手打出歧义。

const SCHOOL_NAME = '广东邮电职业技术学院'

const BUILDINGS = ['进取楼', '团结楼', '博学楼', '精益楼', '敬业楼', '迎宾楼']

function rangeText(from, to, unit) {
  const out = []
  for (let i = from; i <= to; i += 1) out.push(i + unit)
  return out
}

const FLOORS = rangeText(1, 14, '层')
const ROOMS = rangeText(1, 40, '号')

// 「进取楼 · 5层 · 512号」这类展示串
function formatRoom(building, floor, room) {
  if (!building) return ''
  return [building, floor, room].filter(Boolean).join(' · ')
}

// 反解存下来的地址串，回填三级选择器
function parseRoom(text) {
  const empty = { buildingIndex: 0, floorIndex: 0, roomIndex: 0 }
  if (!text) return empty
  const parts = String(text).split('·').map(function (item) {
    return item.trim()
  })
  const buildingIndex = BUILDINGS.indexOf(parts[0])
  const floorIndex = FLOORS.indexOf(parts[1])
  const roomIndex = ROOMS.indexOf(parts[2])
  return {
    buildingIndex: buildingIndex < 0 ? 0 : buildingIndex,
    floorIndex: floorIndex < 0 ? 0 : floorIndex,
    roomIndex: roomIndex < 0 ? 0 : roomIndex,
  }
}

module.exports = {
  SCHOOL_NAME: SCHOOL_NAME,
  BUILDINGS: BUILDINGS,
  FLOORS: FLOORS,
  ROOMS: ROOMS,
  formatRoom: formatRoom,
  parseRoom: parseRoom,
}
