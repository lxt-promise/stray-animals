import { defineStore } from 'pinia'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const TOKEN_KEY = 'catcampus_token'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    school: null,
    ready: false
  }),
  getters: {
    isLogin: (s) => !!s.token,
    isMember: (s) => !!s.user && (s.user.role === 'member' || s.user.role === 'admin'),
    isAdmin: (s) => !!s.user && s.user.role === 'admin'
  },
  actions: {
    async login(username, password) {
      const res = await api.auth.login({ username, password })
      this.token = res.token
      localStorage.setItem(TOKEN_KEY, res.token)
      this.user = res.user
      await this.loadMe()
      return res
    },
    async register(payload) {
      const res = await api.auth.register(payload)
      this.token = res.token
      localStorage.setItem(TOKEN_KEY, res.token)
      this.user = res.user
      await this.loadMe()
      return res
    },
    async loadMe() {
      if (!this.token) { this.ready = true; return }
      try {
        const me = await api.auth.me()
        this.user = me
        if (me && me.schoolId) {
          try { this.school = await api.school.get(me.schoolId) } catch (e) { /* ignore */ }
        }
      } catch (e) {
        this.logout()
      }
      this.ready = true
    },
    logout() {
      this.token = ''
      this.user = null
      this.school = null
      localStorage.removeItem(TOKEN_KEY)
    },
    requireLogin() {
      if (!this.token) {
        ElMessage.warning('请先登录')
        return false
      }
      return true
    }
  }
})
