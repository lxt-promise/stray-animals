import axios from 'axios'
import { ElMessage } from 'element-plus'

const TOKEN_KEY = 'catcampus_token'

const http = axios.create({ baseURL: '/api', timeout: 20000 })

http.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = 'Bearer ' + token
  return config
})

http.interceptors.response.use(
  res => {
    const body = res.data
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data
      if (body.code === 401) {
        localStorage.removeItem(TOKEN_KEY)
        ElMessage.error(body.msg || '登录已过期，请重新登录')
      } else {
        ElMessage.error(body.msg || '请求失败')
      }
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return body
  },
  err => {
    const status = err.response && err.response.status
    if (status === 401) {
      ElMessage.error('请先登录')
    } else {
      ElMessage.error((err.response && err.response.data && err.response.data.msg) || '网络异常')
    }
    return Promise.reject(err)
  }
)

const get = (url, params) => http.get(url, { params }).then(r => r)
const post = (url, data) => http.post(url, data).then(r => r)
// 注意：响应拦截器已经把 body.data 提取出来了，这里不要再取一次 .data
const del = (url) => http.delete(url).then(r => r)

export const api = {
  auth: {
    login: (data) => post('/auth/login', data),
    register: (data) => post('/auth/register', data),
    me: () => get('/auth/me')
  },
  cat: {
    list: (params) => get('/cats', params),
    map: (params) => get('/cats/map', params),
    detail: (id) => get('/cats/' + id),
    save: (data) => post('/cats', data),
    remove: (id) => del('/cats/' + id)
  },
  sighting: {
    list: (params) => get('/sightings', params),
    recent: (params) => get('/sightings/recent', params),
    add: (data) => post('/sightings', data)
  },
  tnr: {
    list: (params) => get('/tnr', params),
    summary: (params) => get('/tnr/summary', params),
    save: (data) => post('/tnr', data)
  },
  task: {
    list: (params) => get('/tasks', params),
    save: (data) => post('/tasks', data),
    // cancel 走 query 参数（后端用 @RequestParam 接收），post() 只透传两个参数
    claim: (id, cancel) => post('/tasks/' + id + '/claim?cancel=' + (cancel ? 'true' : 'false'), null)
  },
  fund: {
    list: (params) => get('/funds', params),
    summary: (params) => get('/funds/summary', params),
    add: (data) => post('/funds', data)
  },
  user: {
    members: (params) => get('/users', params),
    setRole: (id, role) => post('/users/' + id + '/role', { role }),
    apply: (data) => post('/applies', data),
    applies: (params) => get('/applies', params),
    handleApply: (id, approve) => post('/applies/' + id, { approve })
  },
  school: {
    list: () => get('/schools'),
    get: (id) => get('/schools/' + id),
    create: (data) => post('/schools', data),
    bind: (id) => post('/schools/' + id + '/bind')
  },
  stat: {
    overview: (params) => get('/stat/overview', params),
    recent: (params) => get('/stat/recent', params)
  },
  // 识别测试台：后端代转本地 Python 识别服务（浏览器不直连，避免跨域 + token 暴露）
  vision: {
    health: () => get('/vision/health'),
    recognize: (url) => post('/vision/recognize', { url }),
    buildIndex: () => post('/vision/build-index', {})
  },
  // 猫档案手动录入（内部工具）：一次请求完成 上传照片 → 落库 → 同步特征库
  catEntry: (formData) => http.post('/cat-entry', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }),
  upload: (formData) => http.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export default http
