// 枚举 & 常量：前后端共用语义，云函数里保持一致的取值
module.exports = {
  // 猫的状态
  CAT_STATUS: [
    { value: 'campus', label: '在校', tag: 'ok', desc: '常驻校园，稳定出没' },
    { value: 'foster', label: '寄养中', tag: 'purple', desc: '在寄养家庭或医疗点' },
    { value: 'suspend', label: '休学', tag: 'gray', desc: '超过 30 天未见踪迹' },
    { value: 'adopted', label: '毕业', tag: 'info', desc: '已被领养' },
    { value: 'missing', label: '失踪', tag: 'warn', desc: '疑似离开或遭遇意外' },
    { value: 'rainbow', label: '去喵星', tag: 'gray', desc: '已离世，仅作纪念' }
  ],

  // 绝育状态
  STERILIZED: [
    { value: 'yes', label: '已绝育', tag: 'ok' },
    { value: 'no', label: '未绝育', tag: 'warn' },
    { value: 'unknown', label: '未知', tag: 'gray' },
    { value: 'scheduled', label: '已排期', tag: 'info' }
  ],

  SEX: [
    { value: 'male', label: '公' },
    { value: 'female', label: '母' },
    { value: 'unknown', label: '未知' }
  ],

  // 毛色/花纹（用于图鉴与筛选）
  PATTERN: [
    { value: 'tabby', label: '狸花' },
    { value: 'orange', label: '橘猫' },
    { value: 'cow', label: '奶牛' },
    { value: 'tuxedo', label: '燕尾服' },
    { value: 'calico', label: '三花' },
    { value: 'tortoiseshell', label: '玳瑁' },
    { value: 'white', label: '纯白' },
    { value: 'black', label: '纯黑' },
    { value: 'gray', label: '灰蓝' },
    { value: 'siamese', label: '暹罗' },
    { value: 'other', label: '其他' }
  ],

  // 性格标签
  CHARACTER: [
    { value: 'friendly', label: '亲人', tag: 'ok' },
    { value: 'shy', label: '怕生', tag: 'gray' },
    { value: 'foodie', label: '贪吃', tag: '' },
    { value: 'fierce', label: '凶', tag: 'warn' },
    { value: 'quiet', label: '安静', tag: '' },
    { value: 'playful', label: '活泼', tag: '' },
    { value: 'pregnant', label: '疑似怀孕', tag: 'warn' },
    { value: 'injured', label: '伤病', tag: 'warn' },
    { value: 'kitten', label: '幼猫', tag: 'info' }
  ],

  // 健康状态
  HEALTH: [
    { value: 'good', label: '健康', tag: 'ok' },
    { value: 'cold', label: '感冒/喷嚏', tag: 'warn' },
    { value: 'ringworm', label: '猫藓', tag: 'warn' },
    { value: 'stomatitis', label: '口炎', tag: 'warn' },
    { value: 'eye', label: '眼部问题', tag: 'warn' },
    { value: 'injured', label: '外伤', tag: 'warn' },
    { value: 'severe', label: '需紧急送医', tag: 'warn' },
    { value: 'unknown', label: '未知', tag: 'gray' }
  ],

  // 投喂状态（目击打卡时选择：是否投喂、被谁投喂）
  FEED_STATUS: [
    { value: 'passed', label: '路过', tag: 'gray', desc: '只是遇见，本次未投喂' },
    { value: 'fed', label: '本人投喂', tag: 'ok', desc: '我这次投喂了它，可记录食物类型' },
    { value: 'fedByOther', label: '已被其他人投喂', tag: 'info', desc: '看到它正在吃或有余粮，避免重复投喂' }
  ],

  // 食物类型 —— 决定**积分**档位（规则「喂食按食物类型 +2 ~ +5」）。
  // label 直接带分值：用户选的时候就看得见收益，不用去翻规则。
  // ⚠️ value 必须与云函数 index.js 的 FOOD_TYPE_VALUES / FOOD_TYPE_KIND 逐值对齐，
  //    不一致会导致云端白名单过滤后回落到默认档（干粮 +2），用户以为「选了罐头没加分」。
  FOOD_TYPE: [
    { value: 'dry', label: '干粮 +2' },
    { value: 'snack', label: '零食 / 猫条 +3' },
    { value: 'wet', label: '罐头 / 湿粮 +4' },
    { value: 'homemade', label: '自制餐 +5' }
  ],

  // 目击行为标签（结构化多选）
  //
  // ⚠️ 合规要点（2026-10-16 审核驳回「社交-笔记」类目）：
  //   原来是自由文本 textarea「它在做什么？精神状态如何？」——
  //   审核认定「用户自行生成文字 + 图片 + 公开可见」属于社交-笔记，个人主体未开放该类别。
  //   改为**预设标签多选**后，用户只能从枚举里挑，不再创作内容；
  //   功能形态从「写笔记」变成「登记猫况」，与所选「工具-信息查询」类目相符。
  //   新增项请保持"客观状态描述"口径，不要出现主观评价/情绪表达类词汇。
  SIGHT_BEHAVIOR: [
    { value: 'resting', label: '休息/睡觉' },
    { value: 'eating', label: '进食' },
    { value: 'moving', label: '走动' },
    { value: 'playing', label: '玩耍' },
    { value: 'hiding', label: '躲避/怕人' },
    { value: 'alert', label: '警觉观察' },
    { value: 'withOthers', label: '与其他猫同框' },
    { value: 'unusual', label: '状态异常' }
  ],

  // 外观特征标签（结构化多选）
  //
  // ⚠️ 合规要点：打卡页**不得有任何自由文字输入**。
  //   原先「补充（20 字）」input 也已移除 —— 20 字限制只是缓解，本质仍是用户创作文字。
  //   所有"想补充点什么"的需求，一律通过**加枚举项**满足（这里的 SIGHT_FEATURE、
  //   上面的 SIGHT_BEHAVIOR、以及 C.HEALTH 已经覆盖大部分观察维度）。
  //   新增项请保持**客观可观察**口径：能看到的事实，不是主观评价。
  SIGHT_FEATURE: [
    { value: 'earNotch', label: '耳标（已绝育）' },
    { value: 'thin', label: '偏瘦' },
    { value: 'fat', label: '偏胖' },
    { value: 'belly', label: '腹部偏大' },
    { value: 'limping', label: '走路跛行' },
    { value: 'eyeIssue', label: '眼部分泌物' },
    { value: 'noseDry', label: '鼻头干' },
    { value: 'furLoss', label: '局部掉毛' },
    { value: 'collar', label: '戴项圈' },
    { value: 'pregnant', label: '疑似怀孕' }
  ],

  // TNR 流程状态
  TNR_STATUS: [
    { value: 'todo', label: '待抓捕', tag: 'warn' },
    { value: 'trapping', label: '诱捕中', tag: 'info' },
    { value: 'trapped', label: '已捕获', tag: 'info' },
    { value: 'surgery', label: '手术中/住院', tag: 'purple' },
    { value: 'released', label: '已放归', tag: 'ok' },
    { value: 'adopted', label: '转领养', tag: 'info' },
    { value: 'failed', label: '失败/逃脱', tag: 'gray' }
  ],

  // 任务类型（社团排班）
  TASK_TYPE: [
    { value: 'feed', label: '喂猫' },
    { value: 'water', label: '换水/清洁' },
    { value: 'trap', label: '诱捕' },
    { value: 'hospital', label: '送医' },
    { value: 'patrol', label: '巡园' },
    { value: 'adopt', label: '领养对接' },
    { value: 'other', label: '其他' }
  ],

  TASK_STATUS: [
    { value: 'open', label: '待认领', tag: 'warn' },
    { value: 'claimed', label: '已认领', tag: 'info' },
    { value: 'done', label: '已完成', tag: 'ok' },
    { value: 'cancel', label: '已取消', tag: 'gray' }
  ],

  // 资金类别
  FUND_CATEGORY: [
    // 「捐赠」属审核敏感词（易被判定为公开募捐），展示文案改为中性表述；value 保持 donate 不变
    { value: 'donate', label: '自愿资助' },
    { value: 'sale', label: '义卖收入' },
    { value: 'grant', label: '学校/社团拨款' },
    { value: 'tnr', label: '绝育支出' },
    { value: 'medical', label: '医疗支出' },
    { value: 'food', label: '猫粮/物资' },
    { value: 'other', label: '其他' }
  ],

  // 角色
  ROLE: [
    { value: 'visitor', label: '爱猫同学' },
    { value: 'member', label: '社团成员' },
    { value: 'admin', label: '社团管理员' }
  ],

  // 图鉴稀有度（游戏化：按毛色稀缺度 + 状态）
  RARITY: [
    { value: 'common', label: '常见', color: '#B0B0B0' },
    { value: 'uncommon', label: '少见', color: '#3BA776' },
    { value: 'rare', label: '稀有', color: '#4E8FE4' },
    { value: 'epic', label: '史诗', color: '#9B7BE0' },
    { value: 'legend', label: '传说', color: '#FF8A3D' }
  ],

  /**
   * 积分 / 猫粮规则说明（「我的」页与「等级」页共用一份）
   *
   * 之前这段文案在 mine.wxml 里硬编码、points 页再抄一遍，改规则数值时
   * 很容易只改一处 —— 用户看到的规则和云端实际发放就会对不上。
   * 现在只有这一份，两个页面都遍历渲染（WXML 不做字符串拼接）。
   */
  RULES: [
    {
      title: '猫粮值（可增可减，用于消费）',
      lines: [
        '新手礼包 +50（一次性）· 每日打卡 +5 · 建立档案 +15（含照片 +20）· 升级奖励 +50（每级）。每日上限 50，礼包与升级奖励不计入。',
        '识别服务消耗 20 猫粮值/次，首次免费，每天最多 10 次。余额不足时无法发起识别。',
        '超级管理员免消耗：识别、建档等所有消耗猫粮的功能都不扣猫粮，也不占每日次数（用于验收与维护）。'
      ]
    },
    {
      title: '积分值（只增不减，用于升级）',
      lines: [
        '每日打卡 +5 · 投喂干粮 +2 / 零食 +3 / 罐头 +4 / 自制 +5 · 图鉴点亮新品种 +10（每品种一次）。每日上限 150。',
        '积分只涨不降，决定等级称号；花猫粮不影响积分和等级。'
      ]
    },
    {
      title: '等级',
      lines: [
        'Lv.1 猫语新手 0 · Lv.2 爱猫人士 100 · Lv.3 猫界达人 500 · Lv.4 资深铲屎官 1000 · Lv.5 喵星守护者 3000 · Lv.6 传奇喵侠 5000。',
        '等级只升不降，每次升级额外奖励 50 猫粮值。'
      ]
    }
  ],

  // 积分规则（游戏化）
  POINTS: {
    sighting: 10,      // 一次目击打卡
    newCat: 30,        // 上报一只新猫
    firstMeet: 20,     // 首次遇见某只猫（图鉴 +1）
    tnrHelp: 50,       // 参与 TNR 记录
    feed: 10,          // 本人投喂（额外）
    feedPhoto: 15,     // 本人投喂且上传照片（额外，照片是投喂佐证）
    dailyCap: 60       // 每日打卡积分上限
  }
}
