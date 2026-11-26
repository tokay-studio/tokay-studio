/**
 * TOKAY 图生衣工作台 - 服务端
 * 设计原则（对应"任何人用任何账号结果一致"）：
 *  1. Prompt 模板固化在本文件（服务端），前端只能传变量参数，改不了指令骨架
 *  2. API Key 只存在服务端 config.json，浏览器永远拿不到
 *  3. 任务记录落盘 tasks.json，可追溯
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const RESULT_DIR = path.join(ROOT, 'results');
const DEMO_DIR = path.join(ROOT, 'demo');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TASKS_FILE = path.join(ROOT, 'tasks.json');
const CARDS_FILE = path.join(ROOT, 'cards.json');

const PORT = process.env.PORT || 3199;
const MAX_UPLOAD_MB = 15;

// ============ 数据安全：写入前自动备份，损坏自动恢复 ============
const BACKUP_DIR = path.join(ROOT, 'backup');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const KEEP_BACKUPS = 10;
function backupJson(file) {
  try {
    if (!fs.existsSync(file)) return;
    const base = path.basename(file, '.json');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, base + '.' + stamp + '.json'), fs.readFileSync(file));
    // 只保留最近 KEEP_BACKUPS 份
    const olds = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.json'))
      .sort();
    while (olds.length > KEEP_BACKUPS) { try { fs.unlinkSync(path.join(BACKUP_DIR, olds.shift())); } catch { break; } }
  } catch {}
}
function writeJson(file, data) {
  backupJson(file);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  // 主文件损坏：从 backup/ 恢复最近一份
  try {
    const base = path.basename(file, '.json');
    const cands = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of cands) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        console.log('[backup] 已从备份恢复:', base, '<-', f);
        return data;
      } catch {}
    }
  } catch {}
  return fallback;
}

// ============ Prompt 模板（固化，勿随意改动） ============
const STYLE_MAP = {
  gown:    '修身及地长款晚礼服，裁剪贴合身形',
  two:     '两件套套裙：同面料上衣搭配同面料及踝长裙',
  dress:   '收腰中袖连衣裙，裙摆及膝',
  free:    '设计师款长裙',
};
const SCENE_MAP = {
  banquet: '站在豪华宴会厅暖色灯光下，背景轻微虚化',
  runway:  '走在 T 台上，台下观众虚化，聚光灯打在模特身上',
  manor:   '站在户外欧式庄园草坪前，自然光',
  studio:  '浅灰色影棚背景，商业时装大片布光',
};
const MODEL_DESC =
  '一位年轻的尼日利亚非洲女性模特，妆容精致，佩戴金色首饰，站姿优雅';

// 风格效果（look）
const LOOK_MAP = {
  fashion: '', // 现代时装大片（默认，不加额外描述）
  asoebi:
    '整体造型为尼日利亚传统盛典风格（aso-ebi）：模特身穿此面料制成的修身长裙，' +
    '肩上披裹同面料的宽大披肩（ipele），披肩布料完整展开、花型正面朝向镜头，' +
    '一手轻提披肩一角或将布料搭在前臂上，让面料花型大面积完整呈现，布料垂坠自然有光泽；' +
    '头戴同面料 gele 头巾包裹整齐，佩戴金色首饰，造型端庄华丽，如同尼日利亚婚礼盛典上的真实穿搭展示。',
};

// ============ 视频模板（方向②：面料图 → 15s/25s 短视频） ============
// 视频场景模板：动态镜头描述固化在服务端
const VSCENE_MAP = {
  runway: {
    desc: '模特身穿这件面料制成的礼服，在 T 台上从容走秀，台下观众席虚化，聚光灯跟随模特。',
    motion: '镜头先正面跟拍模特前行，随后缓慢环绕模特半圈展示礼服侧面与背面细节，最后定格正面全身。',
  },
  banquet: {
    desc: '模特身穿这件面料制成的礼服，站在豪华宴会厅暖色灯光下，背景水晶吊灯轻微虚化。',
    motion: '镜头缓慢推近至半身展示面料纹理，随后环绕模特一圈，模特优雅转身，礼服随动作自然摆动。',
  },
  manor: {
    desc: '模特身穿这件面料制成的礼服，站在户外欧式庄园草坪前，自然阳光下披肩与裙摆随风轻扬。',
    motion: '镜头低角度缓慢环绕模特，展示面料的光泽与飘逸感，最后镜头拉远至全景。',
  },
  closeup: {
    desc: '这件面料平铺在浅色丝绸衬布上，布料一角被轻轻提起再缓缓落下。',
    motion: '镜头从面料纹理特写开始，缓慢平移展示花型细节与光泽质感，最后缓慢拉远展示整幅面料。',
  },
  tryon: {
    desc: '这位女士身上穿着试穿完成的成品服装，站在浅色影棚背景前，姿态自然自信，服装贴合身形。',
    motion: '镜头正面全身拍摄，模特缓慢原地转身一圈，展示服装的正面、侧面与背面细节，随后回头微笑定格。',
  },
};
const VQUALITY =
  '画面专业稳定，电影级质感，节奏优雅舒缓，光线自然，重点突出面料的花型、色彩与光泽，不变形不失真。';

function buildVideoPrompt({ scene }) {
  const sc = VSCENE_MAP[scene] || VSCENE_MAP.banquet;
  return sc.desc + sc.motion + VQUALITY;
}

// ============ 设计工坊模板（方向③：模糊图 → 高清/线稿/彩绘，供设计师制卡） ============
// mode: sharp=高清修复 | sketch=铅笔线稿(制版) | paint=立体彩绘花(刺绣贴布风格)
const ENHANCE_MAP = {
  sharp: {
    name: '高清修复',
    prompt:
      '将这张模糊的面料花型图修复为超高清版本：花型图案、颜色、构图与原图完全一致，不得改变任何花纹位置和形状。' +
      '只做清晰化处理：去除模糊和噪点，锐化边缘，恢复织物纹理细节，达到印刷级清晰度（4K）。' +
      '平铺正面展示，均匀光照，无阴影无褶皱，纯色背景。',
  },
  sketch: {
    name: '铅笔线稿',
    prompt:
      '将这张面料花型图转换为制版用铅笔线稿（白描风格）：纯白色背景，黑色铅笔线条勾勒花型轮廓与内部结构，' +
      '花型元素与原图完全一致（位置、数量、形态不变），线条流畅清晰、粗细均匀，类似手绘工程制版图。' +
      '不加颜色，不加阴影填充，不加文字和水印。',
  },
  paint: {
    name: '立体彩绘花',
    prompt:
      '将这张面料花型图重绘为立体贴布刺绣花风格插画：花卉元素变成立体拼布/刺绣质感，花瓣有层次厚度和缝线细节，' +
      '色彩鲜艳饱满（保留原图配色体系），元素布局与原图一致，纯白色背景，无阴影投影，' +
      '风格类似手工布艺贴花装饰画，边缘干净利落，高清细节，适合印花制卡使用。不加文字和水印。',
  },
};

function buildEnhancePrompt({ mode }) {
  const m = ENHANCE_MAP[mode] || ENHANCE_MAP.sharp;
  return m.prompt;
}

// ============ 换色工坊（方向④：整体/局部换色） ============
// AI 语义换色模板：fromColor/toColor 是变量，骨架固化
function buildRecolorPrompt({ fromColor, toColor }) {
  const from = (fromColor || '').trim() || '指定的颜色';
  const to = (toColor || '').trim() || '目标颜色';
  return (
    '将这张面料图片进行颜色替换：把图片中所有' + from + '的部分' +
    '（包括边缘、角落、花纹深处、阴影里的该色系区域，全部无一遗漏）统一替换为' + to + '。' +
    '其余颜色的区域保持完全不变。花型图案的形状、位置、分布和织物纹理、光泽质感保持原样。' +
    '换色后整体色调自然协调，明暗光影关系不变，边缘不得残留原色。' +
    '平铺正面展示，高清细节，不加文字和水印。'
  );
}

// ============ 花型工坊（方向⑤：图生图裂变，一张花型 → N 张新花型） ============
const VARIATE_MAP = {
  style: {
    name: '同风格裂变',
    prompt:
      '参考这张面料花型图的艺术风格、工艺质感、元素类型和配色气质，重新设计一张全新的花型图案：' +
      '保留原作的风格基因（同类花卉/几何元素、相似的工艺表现），但花型的具体形态、构图布局和元素组合必须是全新原创，' +
      '与原图明显不同、可明显看出是同一设计系列的新款。整体为适合服装面料的四方连续或自由铺排花型，' +
      '配色协调、细节丰富、织物质感真实。平铺正面展示，均匀光照，无阴影无褶皱，高清细节，4K 画质，不加文字和水印。',
  },
  motif: {
    name: '元素变形',
    prompt:
      '以这张面料花型图中的花卉/图案元素为灵感母题，将元素进行变形演绎（放大缩小、旋转重组、增删繁简），' +
      '生成一张全新的花型图案：元素风格与原图一脉相承，但排列组合方式全新，疏密节奏与原图不同，' +
      '主次元素层级分明，为原创新款设计而非复制。适合服装面料的连续铺排花型，织物质感真实。' +
      '平铺正面展示，均匀光照，高清细节，4K 画质，不加文字和水印。',
  },
  colorway: {
    name: '配色重排',
    prompt:
      '保留这张面料花型图的图案结构与元素布局基本不变，将配色体系重新设计：' +
      '采用与原图不同的全新配色方案（主色、辅色、点缀色整体重排），配色高级和谐，符合国际流行色趋势，' +
      '新配色下的花型明暗层次依然清晰，织物质感真实。平铺正面展示，均匀光照，无阴影无褶皱，高清细节，4K 画质，不加文字和水印。',
  },
  density: {
    name: '疏密重组',
    prompt:
      '以这张面料花型图的元素风格为基础，重新设计花型的疏密与构图节奏：' +
      '与原图明显不同的排列密度（更满铺或更留白），元素大小对比重新安排，构图平衡有呼吸感，' +
      '为同一设计语言的原创新款花型，不是原图复制。适合服装面料的连续铺排，织物质感真实。' +
      '平铺正面展示，均匀光照，高清细节，4K 画质，不加文字和水印。',
  },
};

function buildVariatePrompt({ mode }) {
  const m = VARIATE_MAP[mode] || VARIATE_MAP.style;
  return m.prompt;
}

// ============ ASO-EBI一站式（方向⑥：场景应用，ASO-EBI 一站式活动场景生成） ============
// 尼日利亚活动场合（occasion）
const OCCASION_MAP = {
  birthday: {
    name: '生日会',
    desc: '一场热闹的尼日利亚生日派对：彩色气球与横幅装饰，生日蛋糕摆在桌上，宾客环绕，气氛欢乐',
  },
  wedding: {
    name: '婚礼',
    desc: '一场盛大的尼日利亚传统婚礼：新人居中，装饰着鲜花和金色缎带，宾客环绕见证，场面隆重喜庆',
  },
  naming: {
    name: '满月礼 / 命名礼',
    desc: '一场温馨的尼日利亚婴儿命名礼（Naming Ceremony）：怀抱婴儿的中心人物被亲友环绕，装饰温馨喜庆',
  },
  funeral: {
    name: '葬礼纪念',
    desc: '一场庄重而有尊严的尼日利亚纪念庆典（Celebration of Life）：宾客着装整齐肃立，背景为纪念布置，氛围庄重追思',
  },
  government: {
    name: '政府部门活动',
    desc: '一场正式的政府/公共机构活动：台上嘉宾致辞，台下宾客统一着装列坐，会场布置正式庄重',
  },
  election: {
    name: '总统选举 / 竞选集会',
    desc: '一场热情高涨的竞选集会：大量支持者穿着统一布料的服装聚集挥舞小旗，背景有竞选横幅，气氛热烈有序',
  },
  church: {
    name: '教堂活动 / 感恩奉献',
    desc: '一场教堂感恩奉献礼拜：会众统一着装在教堂内合唱赞美，彩色玻璃窗透入光线，氛围庄严喜乐',
  },
  chieftaincy: {
    name: '酋长授衔 / 传统庆典',
    desc: '一场传统酋长授衔庆典：受衔者身着盛装接受祝福，长者环绕，鼓乐与舞者相伴，传统氛围浓厚',
  },
  custom: {
    name: '自定义场合（用下方描述）',
    desc: '',
  },
};
// 场景瞬间（moment）
const MOMENT_MAP = {
  group: {
    name: '全员统一服装大合影',
    desc: '画面为活动大合影瞬间：全体宾客穿着由这张布料制成的统一款式盛装（aso-ebi），整齐排列面对镜头，笑容满面，气势热闹统一',
  },
  spray: {
    name: '撒钱祝福瞬间',
    desc: '画面定格尼日利亚传统"撒钱祝福"（Money Spraying）瞬间：宾客们将纸币一张一张抛向被祝福者，纸币在空中飞舞飘落，被祝福者笑容满面张开双臂迎接祝福，周围宾客欢呼喝彩，欢乐热烈',
  },
  dance: {
    name: '舞蹈入场欢乐瞬间',
    desc: '画面为舞蹈入场瞬间：被祝福者与亲友们随鼓点起舞入场，统一服装随舞步飞扬，周围宾客鼓掌喝彩，欢乐热烈',
  },
  bless: {
    name: '受礼 / 祝福仪式瞬间',
    desc: '画面为受礼祝福瞬间：长者或主持人向身着统一盛装的被祝福者致以祝福（递送礼品或按手礼），众人环绕见证，庄重而温馨',
  },
};
// 礼品搭配（gifts，可多选）
const GIFT_MAP = {
  fan: '定制电风扇',
  handfan: '定制手工折扇/团扇',
  shoes: '定制布面鞋',
  headwrap: '同布料头巾（gele）',
  bag: '同布料手包',
  umbrella: '定制雨伞',
  cooler: '定制保温箱/餐具礼盒',
};

function buildScenePrompt({ occasion, moment, gifts, extra }) {
  const oc = OCCASION_MAP[occasion] || OCCASION_MAP.birthday;
  const mo = MOMENT_MAP[moment] || MOMENT_MAP.group;
  const ocDesc = oc.desc
    ? '活动场合：' + oc.desc + '。'
    : '';
  let giftDesc = '';
  if (gifts && gifts.length) {
    giftDesc = '画面中同时呈现搭配礼品：' + gifts.map((g) => GIFT_MAP[g] || g).join('、') +
      '（与服装同布料或配套定制，自然出现在宾客手中或活动现场）。';
  }
  const extraDesc = (extra || '').trim().slice(0, 150);
  return (
    '将这张面料图片中的布料完整制成一套尼日利亚传统盛装（aso-ebi 风格），穿在年轻的尼日利亚非洲女性和男性宾客身上，' +
    '男女宾客服装为同一布料的不同款式（长裙、披肩、男式长袍 Agbada、上衣等），头巾与配饰同布料配套。' +
    ocDesc + mo.desc + '。' + giftDesc +
    (extraDesc ? '补充要求：' + extraDesc + '。' : '') +
    '必须严格保留面料的原始花型图案、颜色和织物质感。活动场景真实热闹、人物自然，具有纪实活动摄影质感，' +
    '专业活动跟拍视角，高清写实，画面饱满，8K 画质。不加文字和水印。'
  );
}

// ============ 试衣间（方向⑦：AI 试衣，客户照片试穿打样样品） ============
// 品类映射（对应 aitryon 模型字段，固化在服务端）
const TRYON_TYPE_MAP = {
  dress:      { name: '连衣裙 / 长裙', top: true, bottom: false },
  top:        { name: '上装', top: true, bottom: false },
  bottom:     { name: '下装', top: false, bottom: true },
  top_bottom: { name: '上衣+下装套装', top: true, bottom: true },
  headwrap:   { name: '头巾 / gele', headwrap: true },
};
// 头巾试戴走 qwen-image-edit 拼合图管线（aitryon 不支持头巾品类）
const TRYON_HEADWRAP_PROMPT =
  '参考图由左右两部分拼成：左侧大图为人物照片，右侧为头巾/围巾布料实物图。' +
  '将右侧布料制成传统非洲头巾（gele 头巾），包裹在左侧人物的头上，' +
  '头巾的花型、颜色与包裹方式严格按实物呈现，头巾有光泽感、贴合头部自然。' +
  '人物的面容、表情、姿势、发型、服装与背景保持完全不变，仅添加头巾。' +
  '高清写实摄影质感，8K 画质，不加文字和水印。';

function buildTryonHeadwrapPrompt() { return TRYON_HEADWRAP_PROMPT; }

// 试衣降级指令（aitryon 失败或用户填写了效果描述时，走支持文字指令的编辑模型）
function buildTryonEditPrompt(garmentType, desc) {
  const n = TRYON_TYPE_MAP[garmentType] ? TRYON_TYPE_MAP[garmentType].name : '服装';
  return (
    '本次提供 2-3 张图片：第 1 张是客户的人像照片，其余为待试穿的' + n + '样品图。' +
    '请生成客户穿上样品的写实效果：服装款式、花型、颜色、镶边严格按样品图呈现，不得改变花型分布；' +
    '人物面容、发型、肤色与第 1 张照片保持一致；姿势自然端正，全身照。' +
    '专业时装摄影，高清写实，8K 画质。' +
    (desc ? '补充要求：' + desc : '')
  );
}

// ============ 组合工坊（方向⑧⑨合并：模特+产品组合图 / 海报卡片） ============
// 融合模式指令骨架固化在服务端（变量仅 models/fabrics 数量与 extra 描述行）
function buildCombinePrompt({ models, fabrics, extra }) {
  const nm = Math.max(1, Math.min(2, models || 1));
  const nf = Math.max(1, Math.min(2, fabrics || 1));
  const extraDesc = (extra || '').trim().slice(0, 150);
  return (
    '参考图为拼合的素材图：左侧为模特图（' + nm + '张并列），右侧为面料产品图（' + nf + '张并列）。' +
    '请生成一张自然的组合展示图：模特保持原图的面容、姿势与服装不变，' +
    '将右侧面料布样以自然的方式融入模特所在的同一场景中' +
    '（如悬挂在大理石展架或金色立架上、平铺在前景台面上、立在模特身旁展示），' +
    '同一场景、同一光线与色调，构图协调高级，如同一次专业拍摄完成。' +
    '模特服装的花型、颜色严格保持不变，面料布样的花型、颜色、工艺细节严格按产品图呈现，不得改变花纹。' +
    (extraDesc ? '补充要求：' + extraDesc + '。' : '') +
    '高端电商展示摄影质感，画面真实自然，8K 画质，不加文字和水印。'
  );
}

const ROLE_DESC = {
  fabric: '面料主图（成衣以这张图的花型为准）',
  unfold: '面料展开图（完整幅面的花型与镶边参考）',
  headwrap: '头巾成品参考（gele 头巾的包裹造型按此图）',
  extra: '补充参考素材',
};

// 出图比例（全工坊统一）：映射为画幅指令拼进 prompt
const RATIO_TEXT = {
  '1:1': '出图比例 1:1，正方形构图',
  '3:4': '出图比例 3:4，竖版构图',
  '4:3': '出图比例 4:3，横版构图',
  '9:16': '出图比例 9:16，手机全屏竖版构图',
  '16:9': '出图比例 16:9，宽屏横版构图',
};
function applyRatio(prompt, ratio) {
  const t = RATIO_TEXT[String(ratio || '')];
  return t ? prompt + ' ' + t + '。' : prompt;
}

function buildPrompt({ style, scene, headwrap, look, roles, desc }) {
  const s = STYLE_MAP[style] || STYLE_MAP.gown;
  const sc = SCENE_MAP[scene] || SCENE_MAP.banquet;
  const lookDesc = LOOK_MAP[look] || '';
  // aso-ebi 传统风格自带头巾；现代风格下由用户开关决定
  const hw = (headwrap || look === 'asoebi')
    ? '模特头戴与礼服同面料的头巾（gele 头巾），包裹整齐，有光泽感。'
    : '';
  const r = Array.isArray(roles) ? roles.filter(Boolean) : [];
  let multi = '';
  if (r.length > 1) {
    multi = '本次共提供 ' + r.length + ' 张参考图：' +
      r.map((role, i) => '第' + (i + 1) + '张为' + (ROLE_DESC[role] || ROLE_DESC.extra)).join('，') + '。' +
      '这些参考图均为同一系列花型面料，请把所有参考图中的面料花型统一组合运用到同一套成衣与造型上，花型、颜色、镶边细节严格按对应参考图呈现，不得混用其他花纹。';
  }
  const extra = String(desc || '').trim().slice(0, 200);
  return (
    multi +
    '将这张面料图片中的面料完整制成一件' + s +
    '，穿在' + MODEL_DESC + '身上。' +
    '必须严格保留面料的原始花型图案、纹理、颜色和镶边细节，不得改变花纹分布。' +
    hw + lookDesc +
    '场景：' + sc + '。' +
    (extra ? '补充要求：' + extra + '。' : '') +
    '专业时装摄影，高清写实，正面全身照，8K 画质。'
  );
}

// ============ 生成适配器 ============
/**
 * 统一接口: generateEdit({ imageBase64, mimeType, prompt, config })
 * 返回 [{ url } 或 { base64 }] 数组（本实现每调用一次返回 1 张）
 * images 参数：[{ base64, mime }] 数组（支持多张参考图），兼容旧的单张 (base64, mime) 传法
 */
function normalizeImages(images, imageBase64, mimeType) {
  if (Array.isArray(images)) {
    return images.filter((im) => im && im.base64).map((im) => ({ base64: im.base64, mime: im.mime || 'image/jpeg' }));
  }
  if (imageBase64) return [{ base64: imageBase64, mime: mimeType || 'image/jpeg' }];
  return [];
}

async function callDashscope(cfg, images, imageBase64OrPrompt, maybePrompt) {
  // 兼容旧签名 callDashscope(cfg, base64, mime, prompt)
  let imgs, prompt;
  if (maybePrompt !== undefined) {
    imgs = normalizeImages(null, images, imageBase64OrPrompt);
    prompt = maybePrompt;
  } else {
    imgs = normalizeImages(images);
    prompt = imageBase64OrPrompt;
  }
  if (!imgs.length) throw new Error('未提供参考图片');
  const base = (cfg.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const tryModels = [];
  const userModel = (cfg.model || '').trim();
  if (userModel) tryModels.push(userModel);
  if (!tryModels.includes('qwen-image-3.0')) tryModels.push('qwen-image-3.0');
  if (!tryModels.includes('qwen-image-edit')) tryModels.push('qwen-image-edit'); // 旧名兜底（若平台仍兼容）
  let lastErr = null;
  for (const modelName of tryModels) {
    try {
      return await callDashscopeOnce(cfg, base, modelName, imgs, prompt);
    } catch (err) {
      lastErr = err;
      // 仅模型不存在时尝试下一个模型名，其他错误直接抛出
      if (!/Model not exist|InvalidParameter|model.?not/i.test(String(err.message))) throw err;
    }
  }
  throw lastErr;
}

// 把常见 DashScope 报错翻译成用户能自助解决的提示
function friendlyApiError(msg) {
  const s = String(msg || '');
  if (/InvalidApiKey|Invalid API-key/i.test(s)) return 'API Key 无效或已失效，请到「设置」页重新生成并填入 DashScope API Key（原报错: ' + s.slice(0, 120) + '）';
  if (/Arrearage|overdue payment|欠费/i.test(s)) return '账户余额不足或已欠费，请登录阿里云百炼控制台充值后重试（原报错: ' + s.slice(0, 120) + '）';
  if (/Throttling|RateLimit|并发/i.test(s)) return '请求过于频繁被限流，请稍等片刻再试，或减少一次生成的张数（原报错: ' + s.slice(0, 120) + '）';
  return s;
}
async function callDashscopeOnce(cfg, base, modelName, imgs, prompt) {
  const parts = imgs.map((im) => ({ image: 'data:' + im.mime + ';base64,' + im.base64 }));
  parts.push({ text: prompt });
  const res = await fetch(base + '/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      input: {
        messages: [
          { role: 'user', content: parts },
        ],
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(friendlyApiError('DashScope ' + res.status + ': ' + JSON.stringify(data).slice(0, 300)));
  }
  // 同步返回
  const content = data?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.image) return [{ url: item.image }];
    }
  }
  // 异步任务返回
  const taskId = data?.output?.task_id;
  if (taskId) {
    const imgUrl = await pollDashscopeTask(cfg, base, taskId);
    return [{ url: imgUrl }];
  }
  throw new Error('DashScope 未识别的返回结构: ' + JSON.stringify(data).slice(0, 300));
}

async function pollDashscopeTask(cfg, base, taskId) {
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const r = await fetch(base + '/api/v1/tasks/' + taskId, {
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
    });
    const t = await r.json().catch(() => ({}));
    const status = t?.output?.task_status;
    if (status === 'SUCCEEDED') {
      const results = t?.output?.results || [];
      if (results[0]?.url) return results[0].url;
      throw new Error('任务成功但无结果 URL');
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(friendlyApiError('生成任务失败: ' + (t?.output?.message || status)));
    }
  }
  throw new Error('生成任务超时（10 分钟）');
}

async function callOpenAICompatChat(cfg, images, imageBase64OrPrompt, maybePrompt) {
  let imgs, prompt;
  if (maybePrompt !== undefined) {
    imgs = normalizeImages(null, images, imageBase64OrPrompt);
    prompt = maybePrompt;
  } else {
    imgs = normalizeImages(images);
    prompt = imageBase64OrPrompt;
  }
  if (!imgs.length) throw new Error('未提供参考图片');
  const base = (cfg.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('请在设置里填写 API 地址（baseUrl）');
  const imgParts = imgs.map((im) => ({ type: 'image_url', image_url: { url: 'data:' + im.mime + ';base64,' + im.base64 } }));
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [...imgParts, { type: 'text', text: prompt }],
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('API ' + res.status + ': ' + JSON.stringify(data).slice(0, 300));
  const msg = data?.choices?.[0]?.message;
  // 图片可能在 content 的 markdown 里，或 images 数组，或 b64_json
  const text = typeof msg?.content === 'string' ? msg.content : '';
  const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return [{ url: md[1] }];
  if (Array.isArray(msg?.images) && msg.images.length) {
    const im = msg.images[0];
    const u = typeof im === 'string' ? im : im?.image_url?.url;
    if (u) return [{ url: u }];
  }
  if (msg?.content && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      const u = part?.image_url?.url || (typeof part === 'string' && part.startsWith('data:image') ? part : null);
      if (u) return [{ url: u }];
    }
  }
  throw new Error('返回中未找到图片。原始响应片段: ' + JSON.stringify(data).slice(0, 400));
}

const PROVIDERS = {
  dashscope: callDashscope,
  openai_chat: callOpenAICompatChat,
};

// ---- 视频适配器（阿里百炼 DashScope 图生视频，异步任务） ----
// 模型默认 wan2.6-i2v（支持 15s+），可在 config.json 里 videoModel 覆盖
async function callDashscopeVideo(cfg, imageBase64, mimeType, prompt) {
  const base = (cfg.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const model = cfg.videoModel || 'wan2.6-i2v';
  const res = await fetch(base + '/api/v1/services/aigc/video-generation/video-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: {
        prompt,
        img_url: 'data:' + (mimeType || 'image/jpeg') + ';base64,' + imageBase64,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyApiError('DashScope Video ' + res.status + ': ' + JSON.stringify(data).slice(0, 300)));
  const taskId = data?.output?.task_id;
  if (!taskId) throw new Error('视频任务未返回 task_id: ' + JSON.stringify(data).slice(0, 300));
  return await pollDashscopeVideoTask(cfg, base, taskId);
}

async function pollDashscopeVideoTask(cfg, base, taskId) {
  for (let i = 0; i < 160; i++) {
    await sleep(5000);
    const r = await fetch(base + '/api/v1/tasks/' + taskId, {
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
    });
    const t = await r.json().catch(() => ({}));
    const status = t?.output?.task_status;
    if (status === 'SUCCEEDED') {
      const url = t?.output?.video_url || t?.output?.results?.[0]?.video_url || t?.output?.results?.[0]?.url;
      if (url) return url;
      throw new Error('视频任务成功但无视频 URL');
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error('视频生成失败: ' + (t?.output?.message || status));
    }
  }
  throw new Error('视频生成超时（13 分钟）');
}

const VIDEO_PROVIDERS = {
  dashscope: callDashscopeVideo,
};

// ---- AI 试衣适配器（方向⑦：阿里百炼 aitryon 虚拟试衣，异步任务） ----
function mimeExt(mime) {
  if (/png/i.test(mime || '')) return 'png';
  if (/webp/i.test(mime || '')) return 'webp';
  return 'jpg';
}

// 上传本地文件到 DashScope 临时存储，返回 oss:// URL（48 小时有效）
async function dashscopeUpload(cfg, base, buf, filename, model) {
  const r = await fetch(base + '/api/v1/uploads?action=getPolicy&model=' + encodeURIComponent(model), {
    headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
  });
  const d = await r.json().catch(() => ({}));
  const policy = d?.data;
  if (!policy || !policy.upload_host) {
    throw new Error(friendlyApiError('获取上传凭证失败: ' + JSON.stringify(d).slice(0, 200)));
  }
  const key = policy.upload_dir + '/' + filename;
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('Signature', policy.signature);
  form.append('policy', policy.policy);
  form.append('x-oss-object-acl', policy.x_oss_object_acl || 'private');
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || 'true');
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', new Blob([buf]), filename);
  const up = await fetch(policy.upload_host, { method: 'POST', body: form });
  if (!up.ok) throw new Error('上传图片到临时存储失败: ' + up.status);
  return 'oss://' + key;
}

// 虚拟试衣：人像图 + 服装图（上装/连衣裙 → top_garment_url，下装 → bottom_garment_url）
async function callDashscopeTryon(cfg, personBuf, personMime, garments) {
  const base = (cfg.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const model = cfg.tryonModel || 'aitryon-plus';
  const personUrl = await dashscopeUpload(cfg, base, personBuf, 'person.' + mimeExt(personMime), model);
  const input = { person_image_url: personUrl };
  if (garments.top) {
    input.top_garment_url = await dashscopeUpload(cfg, base, garments.top.buf, 'top.' + mimeExt(garments.top.mime), model);
  }
  if (garments.bottom) {
    input.bottom_garment_url = await dashscopeUpload(cfg, base, garments.bottom.buf, 'bottom.' + mimeExt(garments.bottom.mime), model);
  }
  const res = await fetch(base + '/api/v1/services/aigc/image2image/image-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify({
      model,
      input,
      parameters: { resolution: -1, restore_face: true }, // 保留客户面容与原图分辨率
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyApiError('AITryOn ' + res.status + ': ' + JSON.stringify(data).slice(0, 300)));
  const taskId = data?.output?.task_id;
  if (!taskId) throw new Error('试衣任务未返回 task_id: ' + JSON.stringify(data).slice(0, 300));
  return await pollDashscopeTask(cfg, base, taskId); // 复用通用轮询（3s 一次，结果取 results[0].url）
}

async function runTryonTask(task) {
  task.status = 'running';
  task.results = [];
  task.progress = 0;
  persistTask(task);
  try {
    const cfg = loadConfig();
    const demoMode = cfg.provider !== 'dashscope' || !cfg.apiKey;
    if (demoMode) task.demo = true;
    const personAbs = resolveFileUrl(task.personImagePath);
    if (!personAbs || !fs.existsSync(personAbs)) {
      task.status = 'error';
      task.error = '客户照片文件已丢失，请重新上传';
      persistTask(task);
      return;
    }
    if (demoMode) {
      // 演示模式：用预置效果图模拟试穿结果
      const demoFiles = fs.existsSync(DEMO_DIR)
        ? fs.readdirSync(DEMO_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
        : [];
      if (demoFiles.length === 0) {
        task.status = 'error';
        task.error = 'demo/ 目录没有预置效果图';
        persistTask(task);
        return;
      }
      await sleep(2500);
      const src = path.join(DEMO_DIR, demoFiles[0]);
      const file = path.join(RESULT_DIR, newResultName(task, path.extname(src)));
      fs.copyFileSync(src, file);
      task.results.push('/files/results/' + path.basename(file));
      task.progress = 1;
      task.status = 'done';
      persistTask(task);
      return;
    }
    const personBuf = fs.readFileSync(personAbs);
    const garments = {
      top: task.garments.top
        ? { buf: fs.readFileSync(resolveFileUrl(task.garments.top.imagePath)), mime: task.garments.top.mime }
        : null,
      bottom: task.garments.bottom
        ? { buf: fs.readFileSync(resolveFileUrl(task.garments.bottom.imagePath)), mime: task.garments.bottom.mime }
        : null,
    };
    // 降级用：编辑模型（支持文字指令）多图输入
    const personBase64 = personBuf.toString('base64');
    const editImgs = [{ base64: personBase64, mime: task.personMime || 'image/jpeg' }];
    if (garments.top) editImgs.push({ base64: garments.top.buf.toString('base64'), mime: garments.top.mime });
    if (garments.bottom) editImgs.push({ base64: garments.bottom.buf.toString('base64'), mime: garments.bottom.mime });
    const editPrompt = applyRatio(buildTryonEditPrompt(task.params.garmentType, task.desc), task.params.ratio);
    // 说明：官方 aitryon / aitryon-plus 已于 2026-10-10 下线（阿里公告，推荐替换 qwen-image-3.0）。
    // 默认直接走图像编辑模型（支持文字指令+多图）；仅当用户在管理端显式配置了 tryonModel 时才尝试专线。
    const useDedicated = !!cfg.tryonModel;
    for (let i = 0; i < task.params.count; i++) {
      try {
        if (useDedicated) {
          const url = await callDashscopeTryon(cfg, personBuf, task.personMime || 'image/jpeg', garments);
          task.results.push(await downloadImage(url, newResultName(task)));
        } else {
          const out = await callDashscope(cfg, editImgs, editPrompt);
          if (out[0].url && out[0].url.startsWith('http')) {
            task.results.push(await downloadImage(out[0].url, newResultName(task)));
          } else if (out[0].base64) {
            const file = path.join(RESULT_DIR, newResultName(task));
            fs.writeFileSync(file, Buffer.from(out[0].base64, 'base64'));
            task.results.push('/files/results/' + path.basename(file));
          } else {
            throw new Error('编辑模型未返回图片');
          }
        }
      } catch (err) {
        // 专线失败：自动降级到图像编辑模型（支持文字指令）重试一次
        try {
          const out = await callDashscope(cfg, editImgs, editPrompt);
          if (out[0].url && out[0].url.startsWith('http')) {
            task.results.push(await downloadImage(out[0].url, newResultName(task)));
          } else if (out[0].base64) {
            const file = path.join(RESULT_DIR, newResultName(task));
            fs.writeFileSync(file, Buffer.from(out[0].base64, 'base64'));
            task.results.push('/files/results/' + path.basename(file));
          } else {
            throw new Error('降级模型未返回图片');
          }
          if (useDedicated) {
            task.errors = task.errors || [];
            task.errors.push('第' + (i + 1) + '张: 专用试衣模型不可用（' + err.message.slice(0, 80) + '），已自动改用图像编辑模型生成');
          }
        } catch (err2) {
          task.errors = task.errors || [];
          task.errors.push('第' + (i + 1) + '张: ' + err.message + '；降级重试也失败: ' + err2.message);
        }
      }
      task.progress = i + 1;
      persistTask(task);
    }
  } catch (err) {
    task.status = 'error';
    task.error = err.message;
    persistTask(task);
    return;
  }
  task.status = task.results.length > 0 ? 'done' : 'error';
  if (task.status === 'error') task.error = (task.errors || []).join('；');
  persistTask(task);
}

async function downloadVideo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('下载视频失败: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(RESULT_DIR, crypto.randomUUID() + '.mp4');
  fs.writeFileSync(file, buf);
  return '/files/results/' + path.basename(file);
}

// ============ 配置 ============
function loadConfig() {
  return Object.assign({ provider: 'dashscope', apiKey: '', baseUrl: '', model: '' }, readJsonSafe(CONFIG_FILE, {}));
}
function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

// ============ 任务 ============
function loadTasks() {
  return readJsonSafe(TASKS_FILE, []);
}
function saveTasks(tasks) {
  writeJson(TASKS_FILE, tasks.slice(-200));
}
const tasks = loadTasks(); // { id, createdAt, imagePath, params, prompt, status, results: [], error }
function findTask(id) { return tasks.find((t) => t.id === id); }

// 结果文件智能命名：工坊-日期-序号（下载后好归档）
const WORKSHOP_SLUGS = {
  image: 'model', enhance: 'enhance', variate: 'variate', scene: 'scene',
  tryon: 'tryon', combine: 'combine', recolor: 'recolor', video: 'video',
  card: 'card', poster: 'poster', catalog: 'catalog',
};
function newResultName(task, ext) {
  const slug = WORKSHOP_SLUGS[task.type || 'image'] || 'work';
  const d = new Date();
  const ymd = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return slug + '-' + ymd + '-' + String((task.results || []).length + 1) + (ext || '.png');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============ 名片目录（方向⑩） ============
function loadCards() {
  return readJsonSafe(CARDS_FILE, []);
}
function saveCards(cards) {
  writeJson(CARDS_FILE, cards);
}

// 把 /files/uploads/xxx、/files/results/xxx 解析为磁盘绝对路径；非法输入返回 null
function resolveFileUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^\/files\/(uploads|results)\/([\w.-]+)$/);
  if (!m) return null;
  if (m[1] === 'uploads') return path.join(UPLOAD_DIR, m[2]);
  return path.join(RESULT_DIR, m[2]);
}

async function downloadImage(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('下载结果图失败: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(RESULT_DIR, name || crypto.randomUUID() + '.png');
  fs.writeFileSync(file, buf);
  return '/files/results/' + path.basename(file);
}

// ---- 任务并发队列：百炼限 2 路并发，超出的任务自动排队，避免限流 ----
const MAX_CONCURRENT = 2;
const taskQueue = [];
let runningCount = 0;
function enqueueTask(task, runner) {
  taskQueue.push({ task, runner });
  drainQueue();
}
function drainQueue() {
  while (runningCount < MAX_CONCURRENT && taskQueue.length) {
    const { task, runner } = taskQueue.shift();
    runningCount++;
    Promise.resolve()
      .then(() => runner(task))
      .catch(() => {})
      .finally(() => { runningCount--; drainQueue(); });
  }
}

async function runTask(task) {
  task.status = 'running';
  task.results = [];
  task.progress = 0;
  persistTask(task);
  const cfg = loadConfig();
  const fn = PROVIDERS[cfg.provider];
  const demoMode = !fn || !cfg.apiKey;
  if (demoMode) task.demo = true; // 演示模式：无 Key 时用预置效果图模拟生成
  // 多张参考图（面料图 / 展开图 / 头巾图 / 其他），兼容旧的单一 imagePath
  const imgList = Array.isArray(task.images) && task.images.length
    ? task.images
    : [{ imagePath: task.imagePath, mime: task.mime, role: 'fabric' }];
  const imgs = [];
  for (const im of imgList) {
    const abs = resolveFileUrl(im.imagePath);
    if (!abs || !fs.existsSync(abs)) continue;
    imgs.push({ base64: demoMode ? null : fs.readFileSync(abs).toString('base64'), mime: im.mime || 'image/jpeg', role: im.role });
  }
  if (!imgs.length) {
    task.status = 'error';
    task.error = '面料图文件已丢失，请重新上传';
    persistTask(task);
    return;
  }
  const imageBase64 = demoMode ? null : imgs[0].base64;

  const demoFiles = fs.existsSync(DEMO_DIR)
    ? fs.readdirSync(DEMO_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    : [];

  for (let i = 0; i < task.params.count; i++) {
    let attempt = 0, done = false;
    while (attempt < 2 && !done) { // 单张失败自动重试 1 次（网络抖动容错）
      attempt++;
      try {
        let localUrl;
        if (demoMode) {
          if (demoFiles.length === 0) throw new Error('demo/ 目录没有预置效果图');
          await sleep(2500); // 模拟生成耗时
          const src = path.join(DEMO_DIR, demoFiles[i % demoFiles.length]);
          const file = path.join(RESULT_DIR, newResultName(task, path.extname(src)));
          fs.copyFileSync(src, file);
          localUrl = '/files/results/' + path.basename(file);
        } else {
          const out = await fn(cfg, imgs.map((im) => ({ base64: im.base64, mime: im.mime })), task.prompt);
          if (out[0].url && out[0].url.startsWith('http')) {
            localUrl = await downloadImage(out[0].url, newResultName(task));
          } else if (out[0].base64) {
            const file = path.join(RESULT_DIR, newResultName(task));
            fs.writeFileSync(file, Buffer.from(out[0].base64, 'base64'));
            localUrl = '/files/results/' + path.basename(file);
          } else if (out[0].url && out[0].url.startsWith('data:')) {
            const b64 = out[0].url.split(',')[1];
            const file = path.join(RESULT_DIR, newResultName(task));
            fs.writeFileSync(file, Buffer.from(b64, 'base64'));
            localUrl = '/files/results/' + path.basename(file);
          } else {
            localUrl = out[0].url;
          }
        }
        task.results.push(localUrl);
        done = true;
      } catch (err) {
        if (attempt >= 2) {
          task.errors = task.errors || [];
          task.errors.push('第' + (i + 1) + '张: ' + err.message + (err.message && /timeout|network|ECONN|socket/i.test(err.message) ? '（已自动重试仍失败）' : ''));
        } else {
          await sleep(1500); // 稍等后重试
        }
      }
    }
    task.progress = i + 1;
    persistTask(task);
  }
  task.status = task.results.length > 0 ? 'done' : 'error';
  if (task.status === 'error') task.error = (task.errors || []).join('；');
  persistTask(task);
}
function persistTask(task) {
  saveTasks(tasks);
}

// ---- 极简 ZIP 打包（store 无压缩，零依赖）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosT = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosD = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosT, 10); lh.writeUInt16LE(dosD, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(dosT, 12); ch.writeUInt16LE(dosD, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}
// 删除一个文件（结果图 / 上传图），并从所属任务记录中移除
function removeFileUrl(url) {
  const m = String(url || '').match(/^\/files\/(results|uploads)\/([\w.-]+)$/);
  if (!m) return false;
  const isResult = m[1] === 'results';
  const fname = m[2];
  if (isResult) {
    for (const t of tasks) {
      const r = t.results || [];
      const idx = r.indexOf('/files/results/' + fname);
      if (idx !== -1) {
        r.splice(idx, 1);
        if ((t.progress || 0) > r.length) t.progress = r.length;
        t.descs = t.descs || [];
        for (let d = r.length; d < t.descs.length; d++) delete t.descs[d];
        persistTask(t);
        break;
      }
    }
  }
  try { fs.unlinkSync(path.join(isResult ? RESULT_DIR : UPLOAD_DIR, fname)); } catch {}
  return true;
}

function collectZipEntries(urls) {
  const entries = [];
  const used = new Set();
  for (const u of urls) {
    const m = String(u || '').match(/^\/files\/(results|uploads)\/([\w.-]+)$/);
    if (!m) continue;
    const dir = m[1] === 'results' ? RESULT_DIR : UPLOAD_DIR;
    const abs = path.join(dir, m[2]);
    if (!fs.existsSync(abs)) continue;
    let name = m[2];
    if (used.has(name)) name = path.parse(m[2]).name + '-' + entries.length + path.extname(m[2]);
    used.add(name);
    try { entries.push({ name, data: fs.readFileSync(abs) }); } catch {}
  }
  return entries;
}

// ---- 视频任务（方向②）----
async function runVideoTask(task) {
  task.status = 'running';
  task.results = [];
  task.progress = 0;
  persistTask(task);
  const cfg = loadConfig();
  const fn = VIDEO_PROVIDERS[cfg.provider];
  const demoMode = !fn || !cfg.apiKey;
  if (demoMode) task.demo = true;
  const abs = resolveFileUrl(task.imagePath);
  if (!abs || !fs.existsSync(abs)) {
    task.status = 'error';
    task.error = '面料图文件已丢失，请重新上传';
    persistTask(task);
    return;
  }
  try {
    let localUrl;
    if (demoMode) {
      const demoVideos = fs.existsSync(DEMO_DIR)
        ? fs.readdirSync(DEMO_DIR).filter((f) => /\.mp4$/i.test(f)).sort()
        : [];
      if (demoVideos.length === 0) throw new Error('demo/ 目录没有预置视频，无法演示');
      await sleep(2500); // 模拟生成耗时
      const src = path.join(DEMO_DIR, demoVideos[0]);
      const file = path.join(RESULT_DIR, crypto.randomUUID() + path.extname(src));
      fs.copyFileSync(src, file);
      localUrl = '/files/results/' + path.basename(file);
    } else {
      const mime = task.mime || 'image/jpeg';
      const imageBase64 = fs.readFileSync(abs).toString('base64');
      const videoUrl = await fn(cfg, imageBase64, mime, task.prompt);
      localUrl = videoUrl.startsWith('http') ? await downloadVideo(videoUrl) : videoUrl;
    }
    task.results.push(localUrl);
    task.progress = 1;
    task.status = 'done';
  } catch (err) {
    task.status = 'error';
    task.error = err.message;
  }
  persistTask(task);
}

// ============ HTTP 工具 ============
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, limitMB) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limitMB || 30) * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limitMB) {
  const buf = await readBody(req, limitMB);
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
function serveFile(res, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

// ============ 账号体系（注册/登录/资料/积分） ============
const USERS_FILE = path.join(ROOT, 'users.json');
const TOKENS_FILE = path.join(ROOT, 'tokens.json');
const INIT_POINTS = 500; // 新账号初始积分

function loadUsers() { return readJsonSafe(USERS_FILE, []); }
function saveUsers(us) { writeJson(USERS_FILE, us); }
function loadTokens() { return readJsonSafe(TOKENS_FILE, {}); }
function saveTokens(t) { writeJson(TOKENS_FILE, t); }
function hashPass(salt, pass) { return crypto.scryptSync(String(pass), String(salt), 32).toString('hex'); }
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, points: u.points,
    used: u.used || { images: 0, videos: 0, tasks: 0 }, profile: u.profile || {}, createdAt: u.createdAt };
}
function getAuthUser(req) {
  const t = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (!t) return null;
  const uid = loadTokens()[t];
  if (!uid) return null;
  return loadUsers().find((x) => x.id === uid) || null;
}
function isDemoMode() { return !loadConfig().apiKey; }
function chargeUser(user, n, kind) {
  if (!user || !n || n <= 0) return null;
  const users = loadUsers();
  const u = users.find((x) => x.id === user.id);
  if (!u) return '账号不存在';
  if (u.points < n) return '积分不足：本次需 ' + n + '，剩余 ' + u.points + '，请联系管理员充值';
  u.points -= n;
  u.used = u.used || { images: 0, videos: 0, tasks: 0 };
  if (kind === 'video') u.used.videos += n; else u.used.images += n;
  u.used.tasks += 1;
  saveUsers(users);
  return null;
}
function chargeTask(user, task) {
  const kind = task.type === 'video' ? 'video' : 'image';
  const n = task.type === 'video' ? (task.params.duration || 15) : (task.params.count || 1);
  return chargeUser(user, n, kind);
}

// ============ 路由 ============
// 登录防爆破状态表（内存态，重启即清零）
const loginFails = new Map(); // username(lower) -> { n, lockUntil }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    // CORS 不开放：仅同源使用
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // ---- 账号接口：注册 / 登录 / 登出 / 我的信息 / 资料 ----
    if (p === '/api/auth/register' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$/.test(username)) return sendJson(res, 400, { error: '用户名需 2-24 位字母、数字、下划线或中文' });
      if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
      const users = loadUsers();
      if (users.some((x) => x.username.toLowerCase() === username.toLowerCase())) return sendJson(res, 400, { error: '用户名已存在' });
      const salt = crypto.randomBytes(8).toString('hex');
      const isFirst = users.length === 0;
      const user = {
        id: crypto.randomUUID(),
        username,
        salt,
        passHash: hashPass(salt, password),
        role: isFirst ? 'admin' : 'member',
        points: isFirst ? 99999 : INIT_POINTS,
        used: { images: 0, videos: 0, tasks: 0 },
        profile: { nickname: String(body.nickname || '').trim().slice(0, 30) || username, company: 'TOKAY LACE', phone: '', whatsapp: '', email: '', avatar: '' },
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      saveUsers(users);
      const token = crypto.randomBytes(24).toString('hex');
      const tokens = loadTokens(); tokens[token] = user.id; saveTokens(tokens);
      return sendJson(res, 200, { ok: true, token, user: publicUser(user) });
    }
    // 登录防爆破：同账号连续失败 5 次锁定 10 分钟
    const LOGIN_MAX_FAILS = 5;
    const LOGIN_LOCK_MS = 10 * 60 * 1000;
    function loginFailState(username) {
      if (!loginFails.has(username)) loginFails.set(username, { n: 0, lockUntil: 0 });
      return loginFails.get(username);
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const st = loginFailState(uname);
      if (st.lockUntil > Date.now()) {
        const mins = Math.ceil((st.lockUntil - Date.now()) / 60000);
        return sendJson(res, 429, { error: '尝试次数过多，账号已临时锁定，请约 ' + mins + ' 分钟后再试' });
      }
      const users = loadUsers();
      const user = users.find((x) => x.username.toLowerCase() === uname);
      if (!user || user.passHash !== hashPass(user.salt, String(body.password || ''))) {
        st.n++;
        if (st.n >= LOGIN_MAX_FAILS) {
          st.lockUntil = Date.now() + LOGIN_LOCK_MS;
          st.n = 0;
          return sendJson(res, 429, { error: '连续失败次数过多，账号已锁定 10 分钟' });
        }
        return sendJson(res, 400, { error: '用户名或密码错误（连续失败 ' + st.n + '/' + LOGIN_MAX_FAILS + ' 次后将临时锁定）' });
      }
      loginFails.delete(uname); // 登录成功清零
      const token = crypto.randomBytes(24).toString('hex');
      const tokens = loadTokens(); tokens[token] = user.id; saveTokens(tokens);
      return sendJson(res, 200, { ok: true, token, user: publicUser(user) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const t = req.headers['x-token'] || '';
      const tokens = loadTokens(); delete tokens[t]; saveTokens(tokens);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: '未登录' });
      return sendJson(res, 200, { user: publicUser(user), demo: isDemoMode() });
    }
    if (p === '/api/auth/profile' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: '未登录' });
      const body = await readJson(req, MAX_UPLOAD_MB + 5);
      const users = loadUsers();
      const u = users.find((x) => x.id === user.id);
      if (!u) return sendJson(res, 400, { error: '账号不存在' });
      u.profile = u.profile || {};
      for (const k of ['nickname', 'company', 'phone', 'whatsapp', 'email']) {
        if (body[k] !== undefined) u.profile[k] = String(body[k]).slice(0, 60);
      }
      if (body.avatar && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(body.avatar)) {
        const buf = Buffer.from(body.avatar.split(',')[1], 'base64');
        if (buf.length <= 3 * 1024 * 1024) {
          const name = 'avatar-' + u.id.slice(0, 8) + '.png';
          fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
          u.profile.avatar = '/files/uploads/' + name;
        }
      }
      if (body.newPassword) {
        if (u.passHash !== hashPass(u.salt, String(body.oldPassword || ''))) return sendJson(res, 400, { error: '原密码错误' });
        if (String(body.newPassword).length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
        u.salt = crypto.randomBytes(8).toString('hex');
        u.passHash = hashPass(u.salt, String(body.newPassword));
      }
      saveUsers(users);
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }
    // 管理员充值/调整积分
    if (p === '/api/auth/points' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user || user.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可操作' });
      const body = await readJson(req);
      const users = loadUsers();
      const u = users.find((x) => x.username === String(body.username || ''));
      if (!u) return sendJson(res, 400, { error: '账号不存在' });
      const delta = parseInt(body.delta, 10) || 0;
      u.points = Math.max(0, (u.points || 0) + delta);
      saveUsers(users);
      return sendJson(res, 200, { ok: true, points: u.points });
    }

    // ---- 管理员：用户管理 ----
    if (p === '/api/admin/users' && req.method === 'GET') {
      const me = getAuthUser(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可查看' });
      const users = loadUsers();
      return sendJson(res, 200, {
        users: users.map((u) => ({
          id: u.id, username: u.username, role: u.role, points: u.points || 0,
          createdAt: u.createdAt || '', profile: u.profile || {},
          tasks: tasks.filter((t) => t.user === u.username).length,
        })),
      });
    }
    if (p === '/api/admin/user' && req.method === 'POST') {
      const me = getAuthUser(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可操作' });
      const body = await readJson(req);
      const users = loadUsers();
      const u = users.find((x) => x.username === String(body.username || ''));
      if (!u) return sendJson(res, 400, { error: '账号不存在' });
      if (body.action === 'delete') {
        if (u.username === me.username) return sendJson(res, 400, { error: '不能删除自己的账号' });
        users.splice(users.indexOf(u), 1);
        saveUsers(users);
        return sendJson(res, 200, { ok: true, deleted: true });
      }
      if (body.points !== undefined) {
        const pts = parseInt(body.points, 10);
        if (isNaN(pts) || pts < 0) return sendJson(res, 400, { error: '积分必须是≥0的数字' });
        u.points = pts;
      }
      if (body.newPassword) {
        if (String(body.newPassword).length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
        u.salt = crypto.randomBytes(8).toString('hex');
        u.passHash = hashPass(u.salt, String(body.newPassword));
      }
      if (body.role === 'admin' || body.role === 'member') u.role = body.role;
      saveUsers(users);
      return sendJson(res, 200, { ok: true, user: publicUser(u) });
    }

    // ---- API 鉴权：除登录/注册/公开名片外，所有接口需登录 ----
    if (p.startsWith('/api/') && !p.startsWith('/api/auth/') && !/^\/api\/card\/[\w-]+$/.test(p)) {
      req._user = getAuthUser(req);
      if (!req._user) return sendJson(res, 401, { error: '未登录或登录已过期' });
    }

    // ---- 设置 ----
    if (p === '/api/settings') {
      if (req.method === 'GET') {
        const cfg = loadConfig();
        return sendJson(res, 200, {
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          videoModel: cfg.videoModel || '',
          tryonModel: cfg.tryonModel || '',
          hasKey: !!cfg.apiKey,
          keyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 4) + '****' : '',
        });
      }
      if (req.method === 'POST') {
        if (req._user.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可修改 API 配置' });
        const body = await readJson(req);
        const cfg = loadConfig();
        if (body.provider !== undefined) cfg.provider = String(body.provider);
        if (body.model !== undefined) cfg.model = String(body.model || '');
        if (body.baseUrl !== undefined) cfg.baseUrl = String(body.baseUrl || '');
        if (body.videoModel !== undefined) cfg.videoModel = String(body.videoModel || '');
        if (body.tryonModel !== undefined) cfg.tryonModel = String(body.tryonModel || '');
        if (body.apiKey) cfg.apiKey = String(body.apiKey); // 只写不读回
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, hasKey: !!cfg.apiKey });
      }
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readJson(req, MAX_UPLOAD_MB + 5);
      const m = String(body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
      if (!m) return sendJson(res, 400, { error: '仅支持 png/jpg/webp 图片' });
      const ext = m[1] === 'image/png' ? '.png' : m[1] === 'image/webp' ? '.webp' : '.jpg';
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_UPLOAD_MB * 1024 * 1024) return sendJson(res, 400, { error: '图片超过 ' + MAX_UPLOAD_MB + 'MB' });
      // 内容哈希去重：同一张图重复上传复用同一文件，不重复占盘
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24);
      const name = hash + ext;
      const dest = path.join(UPLOAD_DIR, name);
      const existed = fs.existsSync(dest);
      if (!existed) fs.writeFileSync(dest, buf);
      return sendJson(res, 200, { imagePath: '/files/uploads/' + name, mime: m[1], dedup: existed });
    }

    // 最近上传（供「一键复用」使用）
    if (p === '/api/recent-uploads' && req.method === 'GET') {
      const limit = Math.min(60, Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('limit'), 10) || 12));
      let list = [];
      try {
        list = fs.readdirSync(UPLOAD_DIR)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(UPLOAD_DIR, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
          .slice(0, limit)
          .map((x) => ({ url: '/files/uploads/' + x.f, mime: /\.png$/i.test(x.f) ? 'image/png' : /\.webp$/i.test(x.f) ? 'image/webp' : 'image/jpeg' }));
      } catch {}
      return sendJson(res, 200, { files: list });
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(8, parseInt(body.count, 10) || 1));
      // 多张参考图：[{ imagePath, mime, role }]（role: fabric/unfold/headwrap/extra）
      const VALID_ROLES = ['fabric', 'unfold', 'headwrap', 'extra'];
      const rawImages = Array.isArray(body.images) ? body.images : [];
      const images = rawImages
        .filter((im) => im && im.imagePath)
        .map((im) => ({ imagePath: String(im.imagePath), mime: String(im.mime || 'image/jpeg'), role: VALID_ROLES.includes(im.role) ? im.role : 'extra' }))
        .slice(0, 8);
      const primary = images.find((im) => im.role === 'fabric') || images[0] || null;
      if (!primary) {
        return sendJson(res, 400, { error: '请先上传面料图' });
      }
      const params = {
        style: body.style || 'gown',
        scene: body.scene || 'banquet',
        look: body.look || 'fashion',
        headwrap: !!body.headwrap,
        desc: String(body.desc || '').slice(0, 200),
        ratio: String(body.ratio || ''),
        count,
      };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        imagePath: primary.imagePath, // 任务列表缩略图用
        mime: primary.mime || 'image/jpeg',
        images: images.length ? images : undefined,
        params,
        prompt: applyRatio(buildPrompt({ ...params, roles: images.map((im) => im.role) }), params.ratio), // 模板在服务端固化
        status: 'queued',
        results: [],
        descs: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列（最多2路），前端轮询
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 视频生成（方向②：面料图 → 15s/25s 短视频） ----
    if (p === '/api/generate-video' && req.method === 'POST') {
      const body = await readJson(req);
      const duration = body.duration === 25 ? 25 : 15;
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传面料图' });
      }
      const params = {
        scene: body.scene || 'banquet',
        duration,
        ratio: String(body.ratio || ''),
        count: 1, // 与图片任务字段对齐，便于前端复用
      };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'video',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildVideoPrompt(params), params.ratio), // 运镜模板在服务端固化
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runVideoTask); // 并发队列（最多2路）
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 设计工坊（方向③：模糊图 → 高清/线稿/彩绘） ----
    if (p === '/api/enhance' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 1));
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传面料图' });
      }
      const mode = ENHANCE_MAP[body.mode] ? body.mode : 'sharp';
      const params = { mode, ratio: String(body.ratio || ''), count };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'enhance',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildEnhancePrompt(params), params.ratio), // 模板在服务端固化
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 花型工坊（方向⑤：图生图裂变，一张花型 → 指定数量新花型） ----
    if (p === '/api/variate' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(8, parseInt(body.count, 10) || 8));
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传花型图' });
      }
      const mode = VARIATE_MAP[body.mode] ? body.mode : 'style';
      const params = { mode, ratio: String(body.ratio || ''), count };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'variate',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildVariatePrompt(params), params.ratio), // 模板在服务端固化
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列，每张独立调用模型产生差异
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- ASO-EBI一站式（方向⑥：场景应用，活动场景生成） ----
    if (p === '/api/scene' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(6, parseInt(body.count, 10) || 2));
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传面料图' });
      }
      const occasion = OCCASION_MAP[body.occasion] ? body.occasion : 'birthday';
      const moment = MOMENT_MAP[body.moment] ? body.moment : 'group';
      const gifts = Array.isArray(body.gifts) ? body.gifts.filter((g) => GIFT_MAP[g]).slice(0, 8) : [];
      const params = {
        occasion, moment, gifts,
        extra: String(body.extra || '').slice(0, 150),
        ratio: String(body.ratio || ''),
        count,
      };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'scene',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildScenePrompt(params), params.ratio), // 模板在服务端固化，extra 为唯一用户变量
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 试衣间（方向⑦：AI 试衣，客户照片试穿打样样品） ----
    if (p === '/api/tryon' && req.method === 'POST') {
      const body = await readJson(req);
      const garmentType = TRYON_TYPE_MAP[body.garmentType] ? body.garmentType : 'dress';
      const count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 1));
      if (garmentType === 'headwrap') {
        // 头巾试戴：走 qwen-image-edit 拼合图管线（前端已拼好客户照+布料图）
        const absUpload = resolveFileUrl(body.imagePath);
        if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
          return sendJson(res, 400, { error: '请先上传客户照片与头巾布料图' });
        }
      const params = { garmentType, ratio: String(body.ratio || ''), count };
      const desc = String(body.desc || '').slice(0, 200);
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'tryon',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        desc,
        prompt: applyRatio(buildTryonHeadwrapPrompt() + (desc ? ' 补充要求：' + desc : ''), params.ratio), // 指令在服务端固化
        status: 'queued',
        results: [],
        progress: 0,
      };
        tasks.push(task);
        persistTask(task);
        enqueueTask(task, runTask); // 并发队列
        return sendJson(res, 200, { taskId: task.id });
      }
      // 常规试衣：走 aitryon 专线（人像 + 样品图）
      const personAbs = resolveFileUrl(body.personImagePath);
      if (!body.personImagePath || !personAbs || !fs.existsSync(personAbs)) {
        return sendJson(res, 400, { error: '请先上传客户照片（全身正面单人照）' });
      }
      const need = TRYON_TYPE_MAP[garmentType];
      const garments = {};
      if (need.top) {
        const g = body.garmentTop || {};
        const gAbs = resolveFileUrl(g.imagePath);
        if (!g.imagePath || !gAbs || !fs.existsSync(gAbs)) {
          return sendJson(res, 400, { error: '请先上传' + (garmentType === 'dress' ? '连衣裙样品图' : '上装样品图') });
        }
        garments.top = { imagePath: g.imagePath, mime: g.mime || 'image/jpeg' };
      }
      if (need.bottom) {
        const g = body.garmentBottom || {};
        const gAbs = resolveFileUrl(g.imagePath);
        if (!g.imagePath || !gAbs || !fs.existsSync(gAbs)) {
          return sendJson(res, 400, { error: '请先上传下装样品图' });
        }
        garments.bottom = { imagePath: g.imagePath, mime: g.mime || 'image/jpeg' };
      }
      const desc = String(body.desc || '').slice(0, 200);
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'tryon',
        personImagePath: body.personImagePath,
        personMime: body.personMime || 'image/jpeg',
        garments,
        desc,
        params: { garmentType, ratio: String(body.ratio || ''), count },
        prompt: '虚拟试衣（' + TRYON_TYPE_MAP[garmentType].name + '）：保留客户面容与体型，试穿打样样品（图像编辑模型，参数固化在服务端）' + (desc ? ' 补充要求：' + desc : ''),
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTryonTask); // 并发队列
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 组合工坊：AI 融合组合图（方向⑧：模特图+产品图 → 同场景组合展示图） ----
    if (p === '/api/combine' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 1));
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传模特图与产品图（系统自动拼合参考图）' });
      }
      const params = {
        models: Math.max(1, Math.min(2, parseInt(body.models, 10) || 1)),
        fabrics: Math.max(1, Math.min(2, parseInt(body.fabrics, 10) || 1)),
        extra: String(body.extra || '').slice(0, 150),
        ratio: String(body.ratio || ''),
        count,
      };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'combine',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildCombinePrompt(params), params.ratio), // 指令骨架在服务端固化，extra 为唯一用户变量
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 换色工坊：AI 语义换色（方向④） ----
    if (p === '/api/recolor-ai' && req.method === 'POST') {
      const body = await readJson(req);
      const count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 1));
      const absUpload = resolveFileUrl(body.imagePath);
      if (!body.imagePath || !absUpload || !fs.existsSync(absUpload)) {
        return sendJson(res, 400, { error: '请先上传面料图' });
      }
      const params = {
        fromColor: String(body.fromColor || '').slice(0, 20),
        toColor: String(body.toColor || '').slice(0, 20),
        ratio: String(body.ratio || ''),
        count,
      };
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'recolor',
        imagePath: body.imagePath,
        mime: body.mime || 'image/jpeg',
        params,
        prompt: applyRatio(buildRecolorPrompt(params), params.ratio),
        status: 'queued',
        results: [],
        progress: 0,
      };
      task.user = req._user ? req._user.username : '';
      if (!isDemoMode()) {
        const cErr = chargeTask(req._user, task);
        if (cErr) return sendJson(res, 402, { error: cErr });
      }
      tasks.push(task);
      persistTask(task);
      enqueueTask(task, runTask); // 并发队列
      return sendJson(res, 200, { taskId: task.id });
    }

    // ---- 换色工坊：保存算法精准换色结果（浏览器 Canvas 像素级处理） ----
    if (p === '/api/save-recolor' && req.method === 'POST') {
      const body = await readJson(req, MAX_UPLOAD_MB + 5);
      const m = String(body.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
      if (!m) return sendJson(res, 400, { error: '仅支持 png 格式结果' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > (MAX_UPLOAD_MB + 10) * 1024 * 1024) return sendJson(res, 400, { error: '图片过大' });
      const file = path.join(RESULT_DIR, crypto.randomUUID() + '.png');
      fs.writeFileSync(file, buf);
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: 'recolor',
        imagePath: body.imagePath || '',
        mime: 'image/png',
        params: {
          method: 'pixel',
          fromColor: String(body.fromColor || ''),
          toColor: String(body.toColor || ''),
          tolerance: parseInt(body.tolerance, 10) || 30,
          count: 1,
        },
        prompt: '像素级精准换色（Canvas HSV 算法）：' + (body.fromColor || '') + ' → ' + (body.toColor || ''),
        status: 'done',
        results: ['/files/results/' + path.basename(file)],
        progress: 1,
      };
      task.user = req._user ? req._user.username : ''; // 本地保存不消耗积分
      tasks.push(task);
      persistTask(task);
      return sendJson(res, 200, { ok: true, resultUrl: task.results[0], taskId: task.id });
    }

    // ---- 组合工坊 / 海报工坊：保存本地 Canvas 拼版结果（方向⑧⑨） ----
    if (p === '/api/save-image' && req.method === 'POST') {
      const body = await readJson(req, MAX_UPLOAD_MB + 10);
      const m = String(body.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
      if (!m) return sendJson(res, 400, { error: '仅支持 png 格式结果' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > (MAX_UPLOAD_MB + 10) * 1024 * 1024) return sendJson(res, 400, { error: '图片过大' });
      const file = path.join(RESULT_DIR, crypto.randomUUID() + '.png');
      fs.writeFileSync(file, buf);
      const taskType = body.taskType === 'poster' ? 'poster' : 'composite';
      const task = {
        id: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        type: taskType,
        imagePath: body.imagePath || '',
        mime: 'image/png',
        params: body.params || {},
        prompt: body.prompt || (taskType === 'poster' ? '海报卡片（本地模板排版，无 AI 消耗）' : '模特图+产品图组合图（本地模板拼版，无 AI 消耗）'),
        status: 'done',
        results: ['/files/results/' + path.basename(file)],
        progress: 1,
      };
      task.user = req._user ? req._user.username : ''; // 本地保存不消耗积分
      tasks.push(task);
      persistTask(task);
      return sendJson(res, 200, { ok: true, resultUrl: task.results[0], taskId: task.id });
    }

    // ---- 个人名片（方向⑩：个人名片 + 产品目录大纲） ----
    if (p === '/api/card' && req.method === 'POST') {
      const body = await readJson(req, MAX_UPLOAD_MB + 5);
      const cards = loadCards();
      const id = (body.id && /^[\w-]+$/.test(body.id)) ? body.id : crypto.randomUUID().slice(0, 8);
      const profile = body.profile || {};
      const card = {
        id,
        updatedAt: new Date().toISOString(),
        profile: {
          name: String(profile.name || '').slice(0, 60),
          title: String(profile.title || '').slice(0, 60),
          company: String(profile.company || '').slice(0, 80),
          phone: String(profile.phone || '').slice(0, 40),
          whatsapp: String(profile.whatsapp || '').slice(0, 40),
          email: String(profile.email || '').slice(0, 80),
          address: String(profile.address || '').slice(0, 120),
          slogan: String(profile.slogan || '').slice(0, 80),
          avatar: String(profile.avatar || ''),
        },
        products: (Array.isArray(body.products) ? body.products : []).slice(0, 50).map((pr) => ({
          name: String(pr.name || '').slice(0, 80),
          code: String(pr.code || '').slice(0, 40),
          desc: String(pr.desc || '').slice(0, 200),
          imagePath: String(pr.imagePath || ''),
        })),
      };
      const idx = cards.findIndex((c) => c.id === id);
      if (idx >= 0) cards[idx] = card; else cards.push(card);
      saveCards(cards);
      return sendJson(res, 200, { ok: true, id, cardUrl: '/card/' + id });
    }

    const cardGetMatch = p.match(/^\/api\/card\/([\w-]+)$/);
    if (cardGetMatch && req.method === 'GET') {
      const card = loadCards().find((c) => c.id === cardGetMatch[1]);
      if (!card) return sendJson(res, 404, { error: '名片不存在' });
      return sendJson(res, 200, card);
    }
    if (p === '/api/cards' && req.method === 'GET') {
      return sendJson(res, 200, {
        cards: loadCards().map((c) => ({ id: c.id, name: c.profile.name, company: c.profile.company, updatedAt: c.updatedAt, products: (c.products || []).length })),
      });
    }

    // 打包下载单个任务的全部结果
    const zipMatch = p.match(/^\/api\/task\/([\w-]+)\/zip$/);
    if (zipMatch && req.method === 'GET') {
      const t = findTask(zipMatch[1]);
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      const entries = collectZipEntries(t.results || []);
      if (!entries.length) return sendJson(res, 404, { error: '该任务没有可下载的文件' });
      const buf = buildZip(entries);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="tokay-' + t.id + '.zip"', 'Content-Length': buf.length });
      return res.end(buf);
    }

    // 打包下载多个文件（文件库下载选中）
    if (p === '/api/files-zip' && req.method === 'POST') {
      const body = await readJson(req);
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 200) : [];
      const entries = collectZipEntries(urls);
      if (!entries.length) return sendJson(res, 404, { error: '没有可下载的文件' });
      const buf = buildZip(entries);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="tokay-files.zip"', 'Content-Length': buf.length });
      return res.end(buf);
    }

    // 全量文件：所有任务结果 + 上传的面料图（文件库用）
    if (p === '/api/all-files' && req.method === 'GET') {
      const files = [];
      tasks.forEach((t) => {
        (t.results || []).forEach((u) => files.push({ url: u, type: /\.(mp4|webm)$/i.test(u) ? 'video' : 'result', taskId: t.id, createdAt: t.createdAt || '' }));
      });
      try {
        fs.readdirSync(UPLOAD_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).forEach((f) => {
          const st = fs.statSync(path.join(UPLOAD_DIR, f));
          files.push({ url: '/files/uploads/' + f, type: 'src', createdAt: new Date(st.mtimeMs).toISOString() });
        });
      } catch {}
      return sendJson(res, 200, { files });
    }

    const taskMatch = p.match(/^\/api\/task\/([\w-]+)$/);
    if (taskMatch && req.method === 'GET') {
      const t = findTask(taskMatch[1]);
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, {
        id: t.id, status: t.status, progress: t.progress, total: t.params.count,
        results: t.results, descs: t.descs || [], error: t.error || null, errors: t.errors || [],
        prompt: t.prompt, params: t.params, demo: !!t.demo, type: t.type || 'image', user: t.user || '',
      });
    }

    // 删除任务（请求历史记录），同时清理其结果文件
    if (taskMatch && req.method === 'DELETE') {
      const t = findTask(taskMatch[1]);
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      // 删除该任务的结果文件
      (t.results || []).forEach((u) => {
        const m = String(u).match(/^\/files\/results\/([\w.-]+)$/);
        if (m) { try { fs.unlinkSync(path.join(RESULT_DIR, m[1])); } catch {} }
      });
      const i = tasks.indexOf(t);
      if (i >= 0) tasks.splice(i, 1);
      saveTasks(tasks);
      return sendJson(res, 200, { ok: true });
    }

    // 删除文件库中的单个文件（结果图 / 上传的面料图）
    if (p === '/api/delete-result' && req.method === 'POST') {
      const body = await readJson(req);
      const ok = removeFileUrl(String(body.url || ''));
      if (!ok) return sendJson(res, 400, { error: '无效的文件地址' });
      return sendJson(res, 200, { ok: true, found: true });
    }

    // 批量删除文件（文件库多选）
    if (p === '/api/delete-results' && req.method === 'POST') {
      const body = await readJson(req);
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 500) : [];
      let count = 0;
      for (const raw of urls) if (removeFileUrl(String(raw || ''))) count++;
      return sendJson(res, 200, { ok: true, count });
    }

    // 批量删除任务记录（请求历史多选）
    if (p === '/api/delete-tasks' && req.method === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500).map(String) : [];
      let count = 0;
      for (const id of ids) {
        const t = findTask(id);
        if (!t) continue;
        (t.results || []).forEach((u) => {
          const m = String(u).match(/^\/files\/results\/([\w.-]+)$/);
          if (m) { try { fs.unlinkSync(path.join(RESULT_DIR, m[1])); } catch {} }
        });
        const i = tasks.indexOf(t);
        if (i >= 0) tasks.splice(i, 1);
        count++;
      }
      saveTasks(tasks);
      return sendJson(res, 200, { ok: true, count });
    }

    // 保存单张结果图的描述备注
    if (p === '/api/result-desc' && req.method === 'POST') {
      const body = await readJson(req);
      const t = findTask(String(body.taskId || ''));
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      const idx = parseInt(body.index, 10);
      if (!(idx >= 0)) return sendJson(res, 400, { error: '参数错误' });
      t.descs = t.descs || [];
      t.descs[idx] = String(body.desc || '').slice(0, 200);
      persistTask(t);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/tasks' && req.method === 'GET') {
      const qs = new URL(req.url, 'http://x').searchParams;
      const limit = Math.min(1000, Math.max(1, parseInt(qs.get('limit'), 10) || 30));
      return sendJson(res, 200, {
        total: tasks.length,
        tasks: tasks.slice(-limit).reverse().map((t) => ({
          id: t.id, createdAt: t.createdAt, status: t.status,
          progress: t.progress, total: t.params.count, results: t.results,
          error: t.error || null, demo: !!t.demo, params: t.params, type: t.type || 'image', user: t.user || '',
        })),
      });
    }

    // ---- 静态文件 ----
    if (p.startsWith('/files/uploads/')) return serveFile(res, path.join(UPLOAD_DIR, path.basename(p)));
    if (p.startsWith('/files/results/')) return serveFile(res, path.join(RESULT_DIR, path.basename(p)));
    const cardPageMatch = p.match(/^\/card\/([\w-]+)$/);
    if (cardPageMatch) return serveFile(res, path.join(PUBLIC_DIR, 'card.html')); // 手机端在线名片页
    const catalogPageMatch = p.match(/^\/catalog\/([\w-]+)$/);
    if (catalogPageMatch) return serveFile(res, path.join(PUBLIC_DIR, 'catalog.html')); // 独立产品目录页（发客户直链）
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (p.startsWith('/public/')) return serveFile(res, path.join(PUBLIC_DIR, path.basename(p)));
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error('[error]', p, err.message);
    try { sendJson(res, 500, { error: err.message }); } catch {}
  }
});

// 健康检查（Koyeb/Render 等平台探活用）
if (p === '/api/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });

server.listen(PORT, '0.0.0.0', () => {
  console.log('TOKAY 图生衣工作台已启动: http://localhost:' + PORT);
});
