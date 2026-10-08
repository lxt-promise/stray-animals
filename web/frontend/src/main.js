import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import 'leaflet/dist/leaflet.css'
import './styles/main.css'

import App from './App.vue'
import router from './router'
import { useUserStore } from '@/stores/user'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(ElementPlus, { locale: zhCn })
app.use(router)

// 路由守卫：先确保用户信息已加载，再判断权限
router.beforeEach(async (to) => {
  const store = useUserStore(pinia)
  if (!store.ready) await store.loadMe()

  if (to.meta.auth && !store.isLogin) {
    ElMessage.warning('请先登录')
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.member && !store.isMember) {
    ElMessage.warning('需要社团成员权限，可先提交入社申请')
    return { name: 'home' }
  }
  return true
})

app.mount('#app')
