/** Entirely synthetic fixtures. No company, personal name or credit code is verified real data. */
export const DEMO_METADATA = Object.freeze({
  synthetic: true,
  notice: '全部企业、工商信息、资质及产业链标签均为虚构演示数据；DEMO 开头的信用代码为演示标识，不代表真实或通过校验的统一社会信用代码。',
  baselineAt: '2026-10-26T09:00:00+08:00',
  changedAt: '2026-10-27T09:30:00+08:00',
  provenance: '企查查 / 天眼查字段结构演示模板；未调用厂商真实接口。专题标签由本地文件补充，未假定基础工商 API 包含资质与产业链数据。',
});

const definitions = [
  ['星澜光电科技','安徽省','合肥市','蜀山区','电子信息','中型',['高新技术企业','专精特新中小企业'],['显示面板','显示模组'],26000],
  ['云启显示技术','安徽省','合肥市','瑶海区','电子信息','大型',['高新技术企业'],['显示面板'],52000],
  ['皖芯微电子','安徽省','合肥市','包河区','电子信息','小型',['高新技术企业','科技型中小企业'],['芯片设计'],8000],
  ['青禾先进材料','安徽省','芜湖市','鸠江区','新材料','中型',['高新技术企业','创新型中小企业'],['关键材料'],15000],
  ['远辰智能装备','安徽省','合肥市','蜀山区','装备制造','中型',['专精特新中小企业'],['智能装备'],12000],
  ['星储能源技术','安徽省','滁州市','南谯区','新能源','大型',['高新技术企业'],['储能系统'],68000],
  ['合源软件服务','安徽省','合肥市','庐阳区','现代服务','小型',['科技型中小企业'],['软件服务'],2000],
  ['澄镜光学科技','安徽省','蚌埠市','禹会区','电子信息','中型',['高新技术企业','专精特新中小企业'],['光学组件','显示模组'],9800],
  ['苏辰光电科技','江苏省','苏州市','吴中区','电子信息','中型',['高新技术企业','专精特新中小企业'],['显示模组'],22000],
  ['江启精密制造','江苏省','南京市','江宁区','装备制造','大型',['高新技术企业'],['智能装备'],45000],
  ['澜芯集成科技','江苏省','无锡市','滨湖区','电子信息','小型',['科技型中小企业'],['芯片设计'],7500],
  ['苏泽功能材料','江苏省','常州市','武进区','新材料','中型',['创新型中小企业'],['关键材料'],11000],
  ['宁远储能科技','江苏省','南京市','浦口区','新能源','中型',['高新技术企业'],['储能系统'],19000],
  ['浙星显示科技','浙江省','杭州市','滨江区','电子信息','大型',['高新技术企业','专精特新中小企业'],['显示面板'],76000],
  ['越明光学技术','浙江省','绍兴市','越城区','电子信息','小型',['科技型中小企业'],['光学组件'],5600],
  ['甬新装备技术','浙江省','宁波市','鄞州区','装备制造','中型',['高新技术企业'],['智能装备'],18000],
  ['禾清生物科技','浙江省','嘉兴市','南湖区','生物医药','小型',['科技型中小企业','创新型中小企业'],['关键材料'],4300],
  ['京澜数字技术','北京市','北京市','海淀区','现代服务','中型',['高新技术企业'],['软件服务'],13500],
  ['京星芯片设计','北京市','北京市','朝阳区','电子信息','微型',['科技型中小企业'],['芯片设计'],1200],
  ['鹏启光电技术','广东省','深圳市','南山区','电子信息','大型',['高新技术企业','专精特新中小企业'],['显示面板','显示模组'],85000],
  ['湾澄智能科技','广东省','深圳市','宝安区','装备制造','小型',['创新型中小企业'],['智能装备'],6200],
  ['珠星能源科技','广东省','珠海市','香洲区','新能源','中型',['高新技术企业'],['储能系统'],28000],
  ['蓉启数据服务','四川省','成都市','武侯区','现代服务','小型',['科技型中小企业'],['软件服务'],3300],
  ['川澄新材料','四川省','绵阳市','涪城区','新材料','中型',['高新技术企业'],['关键材料'],16700],
  ['皖新显示模组','安徽省','合肥市','蜀山区','电子信息','小型',['高新技术企业','科技型中小企业'],['显示模组'],8800],
  ['苏新光学组件','江苏省','苏州市','相城区','电子信息','中型',['高新技术企业'],['光学组件'],13500],
];

export const DEMO_COMPANIES = definitions.map((d, i) => ({
  enterpriseName: `演示${d[0]}有限公司`,
  creditCode: `DEMO-CN-${String(i + 1).padStart(6, '0')}`,
  legalPerson: `演示法人${String(i + 1).padStart(2, '0')}`,
  registrationStatus: '存续', establishedAt: `20${String(10 + i % 12).padStart(2, '0')}-${String(i % 12 + 1).padStart(2, '0')}-15`,
  registeredCapitalWan: d[8], regionProvince: d[1], regionCity: d[2], regionDistrict: d[3],
  industry: d[4], scale: d[5], qualifications: d[6], chainNodes: d[7],
  registeredAddress: `${d[1]}${d[2]}${d[3]}演示产业园${i + 1}号`,
  businessScope: '演示产品研发、生产及技术服务；具体经营范围为虚构样例。',
  synthetic: true,
}));

const qccRow = (c, i) => ({
  Name: c.enterpriseName, CreditCode: c.creditCode, OperName: c.legalPerson, Status: c.registrationStatus,
  StartDate: c.establishedAt.replaceAll('-', '/'), RegistCapi: c.registeredCapitalWan * 10000,
  Province: c.regionProvince, City: c.regionCity, District: c.regionDistrict, Industry: c.industry,
  Scope: c.businessScope, Address: c.registeredAddress, UpdatedAt: DEMO_METADATA.baselineAt,
  _synthetic: true, _demoSource: '企查查字段模板，非真实 API 响应',
});
const tycRow = (c, i) => ({
  name: c.enterpriseName, creditCode: c.creditCode, legalPersonName: i === 0 ? '演示法人01乙' : c.legalPerson,
  regStatus: c.registrationStatus, estiblishTime: Date.parse(`${c.establishedAt}T00:00:00+08:00`),
  regCapital: i === 0 ? 25500 : c.registeredCapitalWan,
  province: c.regionProvince, city: c.regionCity, district: c.regionDistrict, industry: c.industry,
  businessScope: c.businessScope, regLocation: c.registeredAddress,
  updateTime: DEMO_METADATA.baselineAt, _synthetic: true, _demoSource: '天眼查字段模板，非真实 API 响应',
});
const fileRow = c => ({
  '企业全称': c.enterpriseName, '统一社会信用代码': c.creditCode,
  '企业资质': c.qualifications.join('；'), '企业规模': c.scale, '产业链节点': c.chainNodes.join('；'),
  '数据更新时间': DEMO_METADATA.baselineAt, _synthetic: true,
});
const copy = v => JSON.parse(JSON.stringify(v));
const q1 = DEMO_COMPANIES.slice(0, 24).map(qccRow);
const t1 = DEMO_COMPANIES.slice(0, 24).map(tycRow);
const f1 = DEMO_COMPANIES.slice(0, 24).map(fileRow);
const q2 = DEMO_COMPANIES.slice(0, 25).map(qccRow);
q2[0].RegistCapi = 280000000; q2[0].UpdatedAt = DEMO_METADATA.changedAt;
q2[4].Address = '安徽省合肥市蜀山区演示智能制造园28号'; q2[4].UpdatedAt = DEMO_METADATA.changedAt;
q2[24].UpdatedAt = DEMO_METADATA.changedAt;
const t2 = DEMO_COMPANIES.slice(0, 26).map(tycRow);
t2[0].regCapital = 27000; t2[0].updateTime = DEMO_METADATA.changedAt;
t2[8].legalPersonName = '演示法人09新'; t2[8].updateTime = DEMO_METADATA.changedAt;
t2[24].updateTime = DEMO_METADATA.changedAt; t2[25].updateTime = DEMO_METADATA.changedAt;
const f2 = DEMO_COMPANIES.slice(0, 25).map(fileRow);
f2[4]['企业资质'] = '专精特新中小企业；高新技术企业'; f2[4]['数据更新时间'] = DEMO_METADATA.changedAt;
f2[24]['数据更新时间'] = DEMO_METADATA.changedAt;

export const DEMO_SNAPSHOTS = {
  qcc: { v1: copy(q1), v2: copy(q2) },
  tyc: { v1: copy(t1), v2: copy(t2) },
  file: { v1: copy(f1), v2: copy(f2) },
};

export const DEFAULT_FILTERS = Object.freeze({ regionProvince: '', regionCity: '', industry: '', qualification: '', scale: '', chainNode: '', keyword: '' });
