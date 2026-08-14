// 重点个股清单：科技半导体三大板块（星大派特刊口径）。
// 三条链：国产链（存储+设备+材料）、海外链（光模块+InP+英伟达链条）、封测（先进封装）。
// 本清单是公开的股票科普数据（公司名 + 公开代码 + 定位），非个人隐私。
// 公司名作为唯一标识（关注 id）。股票代码为默认值，可由用户在界面覆盖（见 stock-codes.mjs）。

const ENTITY_PAGE_NAMES = new Set([
  "中际旭创",
  "新易盛",
  "天孚通信",
  "云南锗业",
  "源杰科技",
  "生益科技",
  "南大光电",
]);

// 实体页路径固定为 02_Areas/股票/实体/<公司名>.md，预编码成 obsidian id，
// 前端直接 onOpenDocument(entityPageId) 即可，无需前端做 base64url 编码。
function entityPageId(name) {
  const relativePath = `02_Areas/股票/实体/${name}.md`;
  const encoded = Buffer.from(relativePath, "utf8").toString("base64url");
  return `obsidian-${encoded}`;
}

function stock(name, note, code = null) {
  const hasEntityPage = ENTITY_PAGE_NAMES.has(name);
  return {
    name,
    note,
    code,
    hasEntityPage,
    entityPageId: hasEntityPage ? entityPageId(name) : null,
  };
}

export const STOCK_CHAINS = [
  {
    key: "domestic",
    label: "国产链",
    description: "存储 + 设备 + 材料（政策+内需自主可控主线）",
    segments: [
      {
        label: "存储",
        stocks: [
          stock("长鑫存储", "DRAM 龙头，已上市，HBM 推进中", "688825"),
          stock("长江存储", "NAND 龙头（未上市，无 A 股代码）"),
          stock("兆易创新", "NOR Flash + 利基 DRAM 设计", "603986"),
          stock("澜起科技", "内存接口芯片（DDR5/HBM 相关）", "688008"),
        ],
      },
      {
        label: "设备",
        stocks: [
          stock("北方华创", "平台型设备龙头（刻蚀/沉积/清洗等）", "002371"),
          stock("中微公司", "介质刻蚀龙头，高深宽比技术", "688012"),
          stock("拓荆科技", "薄膜沉积（PECVD）设备", "688072"),
          stock("盛美上海", "清洗设备", "688082"),
          stock("科玛科技", "陶瓷设备（同「珂玛科技」）", "688266"),
          stock("华海清科", "CMP 设备", "688120"),
        ],
      },
      {
        label: "材料",
        stocks: [
          stock("沪硅产业", "12 英寸大硅片", "688126"),
          stock("安集科技", "CMP 抛光液", "688019"),
          stock("鼎龙股份", "CMP 抛光垫等", "300054"),
          stock("雅克科技", "前驱体材料", "002409"),
          stock("南大光电", "光刻胶", "300346"),
          stock("江丰电子", "溅射靶材", "300666"),
        ],
      },
    ],
  },
  {
    key: "overseas",
    label: "海外链",
    description: "光模块 + InP + 英伟达链条（全球 AI 出口红利）",
    segments: [
      {
        label: "光模块",
        stocks: [
          stock("中际旭创", "全球光模块龙头，英伟达核心供应商", "300308"),
          stock("新易盛", "全球第二，硅光/LPO 优势明显", "300502"),
          stock("天孚通信", "光器件/引擎，CPO 相关领先", "300394"),
        ],
      },
      {
        label: "磷化铟 InP",
        stocks: [
          stock("云南锗业", "InP 衬底龙头，国内市占领先", "002428"),
          stock("源杰科技", "高速光芯片（EML/VCSEL）", "688498"),
          stock("三安光电", "化合物半导体垂直整合（外延+芯片）", "600703"),
          stock("光迅科技", "光芯片+模块 IDM", "002281"),
        ],
      },
      {
        label: "英伟达链条",
        stocks: [
          stock("沪电股份", "高速 PCB/背板，英伟达核心", "002463"),
          stock("胜宏科技", "AI 服务器主板/HDI，弹性大", "300476"),
          stock("生益科技", "高端 CCL 覆铜板（M9 认证）", "600183"),
          stock("工业富联", "AI 服务器 ODM 组装", "601138"),
        ],
      },
    ],
  },
  {
    key: "packaging",
    label: "封测",
    description: "先进封装（中游平台型观察，同时服务国产与海外）",
    segments: [
      {
        label: "先进封装",
        stocks: [
          stock("长电科技", "国内第一，HBM/2.5D/3D/Chiplet/CPO 全栈", "600584"),
          stock("通富微电", "AMD 深度绑定，高性能封装弹性大", "002156"),
          stock("华天科技", "偏国产存储封装", "002185"),
          stock("太极实业", "海太半导体，SK 海力士 HBM 核心", "600667"),
          stock("甬矽电子", "高端先进封装扩产积极", "688362"),
        ],
      },
    ],
  },
];

// codeOverrides: { 公司名: 覆盖后的代码 }（来自 stock-codes.mjs）。合并逻辑：
// 有覆盖时用覆盖值，否则用默认 code。覆盖值为 null 表示「明确标记为无代码」。
export function stockUniversePayload(codeOverrides = {}) {
  const applyCode = (name, defaultCode) =>
    Object.prototype.hasOwnProperty.call(codeOverrides, name)
      ? codeOverrides[name]
      : defaultCode;

  const chains = STOCK_CHAINS.map((chain) => ({
    key: chain.key,
    label: chain.label,
    description: chain.description,
    segments: chain.segments.map((segment) => ({
      label: segment.label,
      stocks: segment.stocks.map((item) => ({
        ...item,
        code: applyCode(item.name, item.code),
      })),
    })),
  }));

  const total = STOCK_CHAINS.reduce(
    (sum, chain) => sum + chain.segments.reduce((s, seg) => s + seg.stocks.length, 0),
    0,
  );
  return { generatedAt: new Date().toISOString(), total, chains };
}
