import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/cats', name: 'cats', component: () => import('@/views/CatsView.vue') },
  { path: '/cats/:id', name: 'cat-detail', component: () => import('@/views/CatDetailView.vue') },
  { path: '/cats/:id/edit', name: 'cat-edit', component: () => import('@/views/CatEditView.vue'), meta: { member: true } },
  { path: '/map', name: 'map', component: () => import('@/views/MapView.vue') },
  { path: '/sighting', name: 'sighting', component: () => import('@/views/SightingView.vue'), meta: { auth: true } },
  { path: '/workbench', name: 'workbench', component: () => import('@/views/WorkbenchView.vue') },
  { path: '/tnr', name: 'tnr', component: () => import('@/views/TnrView.vue'), meta: { member: true } },
  { path: '/task', name: 'task', component: () => import('@/views/TaskView.vue') },
  { path: '/fund', name: 'fund', component: () => import('@/views/FundView.vue'), meta: { member: true } },
  { path: '/member', name: 'member', component: () => import('@/views/MemberView.vue') },
  { path: '/mine', name: 'mine', component: () => import('@/views/MineView.vue'), meta: { auth: true } },
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
  // 识别测试台：内部调试工具，建议只在开发环境暴露
  { path: '/vision', name: 'vision', component: () => import('@/views/VisionTestView.vue') },
  // 猫档案手动录入：内部工具，往档案库 + 特征库里加猫
  { path: '/cat-entry', name: 'catEntry', component: () => import('@/views/CatEntryView.vue') }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
