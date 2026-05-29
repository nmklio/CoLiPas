import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Activity, AlertTriangle, Globe2, LocateFixed, MapPin, Minus, Network, Plus, RotateCcw, Server, ShieldCheck, Wifi } from 'lucide-react';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import countriesAtlas from 'world-atlas/countries-110m.json';
import { useI18n } from '../../i18n';
import { OperationEvent, ServerNode } from '../../types';
import { formatCountryName, formatRegionName, percentClass, statusLabel } from '../../utils/format';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

interface MonitoringOverviewProps {
  servers: ServerNode[];
  events: OperationEvent[];
  onlineCount: number;
  avgCpu: number;
  onRegionServersOpen?: (region: string | string[]) => void;
}

interface RegionNode {
  region: string;
  total: number;
  running: number;
  warning: number;
  avgCpu: number;
  providers: string[];
  serverNames: string[];
  lat: number;
  lng: number;
  countryIds: string[];
  x: number;
  y: number;
  placeholder?: boolean;
}

interface RegionLocation {
  lat: number;
  lng: number;
  countryId: string;
  countryIds?: string[];
  matched?: boolean;
}

interface CountryHover {
  countryName: string;
  title: string;
  regions: RegionNode[];
  total: number;
  running: number;
  serverNames: string[];
  x: number;
  y: number;
}

interface MapCountryShape {
  id: string;
  path: string;
  name: string;
  centroid: [number, number];
}

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 520;
const tooltipServerNameLimit = 6;

const countries = feature(
  countriesAtlas as never,
  (countriesAtlas as { objects: { countries: unknown } }).objects.countries as never,
) as unknown as FeatureCollection<Geometry, { name?: string }>;

const projection = geoEquirectangular().fitExtent(
  [[16, 20], [984, 500]],
  { type: 'Sphere' },
);
const mapPath = geoPath(projection);
const mapCountryShapes: MapCountryShape[] = countries.features.map((country) => {
  const typedCountry = country as Feature<Geometry, { name?: string }>;
  const centroid = mapPath.centroid(typedCountry);

  return {
    id: normalizeCountryId(country.id),
    path: mapPath(typedCountry) ?? '',
    name: typedCountry.properties?.name ?? '',
    centroid: [centroid[0], centroid[1]],
  };
});
const mapCountryIds = new Set(mapCountryShapes.map((country) => country.id));

const countryCodeLocations: Record<string, RegionLocation> = {
  AU: { lat: -33.8688, lng: 151.2093, countryId: '036', matched: true },
  BR: { lat: -23.5558, lng: -46.6396, countryId: '076', matched: true },
  CA: { lat: 43.6532, lng: -79.3832, countryId: '124', matched: true },
  CN: { lat: 31.2304, lng: 121.4737, countryId: '156', matched: true },
  DE: { lat: 50.1109, lng: 8.6821, countryId: '276', matched: true },
  FR: { lat: 48.8566, lng: 2.3522, countryId: '250', matched: true },
  GB: { lat: 51.5072, lng: -0.1276, countryId: '826', matched: true },
  HK: { lat: 22.3193, lng: 114.1694, countryId: '344', countryIds: ['156'], matched: true },
  IE: { lat: 53.3498, lng: -6.2603, countryId: '372', matched: true },
  IN: { lat: 19.076, lng: 72.8777, countryId: '356', matched: true },
  JP: { lat: 35.6762, lng: 139.6503, countryId: '392', matched: true },
  KR: { lat: 37.5665, lng: 126.978, countryId: '410', matched: true },
  NL: { lat: 52.3676, lng: 4.9041, countryId: '528', matched: true },
  SE: { lat: 59.3293, lng: 18.0686, countryId: '752', matched: true },
  SG: { lat: 1.3521, lng: 103.8198, countryId: '702', countryIds: ['458'], matched: true },
  TW: { lat: 25.033, lng: 121.5654, countryId: '158', matched: true },
  UK: { lat: 51.5072, lng: -0.1276, countryId: '826', matched: true },
  US: { lat: 39.8283, lng: -98.5795, countryId: '840', matched: true },
  ZA: { lat: -33.9249, lng: 18.4241, countryId: '710', matched: true },
};

const shortRegionExpansions: Record<string, string> = {
  la: 'los angeles',
  lax: 'los angeles',
  ny: 'new york',
  nyc: 'new york',
  sf: 'san francisco',
  sjc: 'san jose',
  nrt: 'tokyo',
  tyo: 'tokyo',
};

const regionLocations: Array<{ aliases: string[]; location: RegionLocation }> = [
  { aliases: ['cn-hangzhou', 'cn-qingdao', 'cn-zhangjiakou', 'cn-huhehaote', 'cn-wulanchabu', 'ap-guangzhou', 'ap-shanghai', 'ap-beijing'], location: countryCodeLocations.CN },
  { aliases: ['ap-hongkong', 'ap-east-1', 'eastasia', 'tencent-hk', 'aliyun-hk'], location: countryCodeLocations.HK },
  { aliases: ['ap-singapore', 'ap-southeast-1', 'asia-southeast1', 'southeastasia', 'tencent-sg', 'aliyun-sg'], location: countryCodeLocations.SG },
  { aliases: ['ap-japan', 'ap-northeast-1', 'japaneast', 'japanwest', 'asia-northeast1', 'asia-northeast2', 'asia-northeast3', 'tencent-jp', 'aliyun-jp'], location: countryCodeLocations.JP },
  { aliases: ['ap-seoul', 'ap-northeast-2', 'koreacentral', 'koreasouth', 'tencent-kr'], location: countryCodeLocations.KR },
  { aliases: ['ap-mumbai', 'ap-south-1', 'centralindia', 'southindia', 'asia-south1', 'asia-south2', 'tencent-in', 'aliyun-in'], location: countryCodeLocations.IN },
  { aliases: ['ap-sydney', 'ap-southeast-2', 'australiaeast', 'australiasoutheast', 'australia-southeast1', 'australia-southeast2'], location: countryCodeLocations.AU },
  { aliases: ['eu-frankfurt', 'eu-central-1', 'germanywestcentral', 'europe-west3', 'europe-west8', 'europe-west10', 'tencent-de', 'aliyun-de'], location: countryCodeLocations.DE },
  { aliases: ['eu-london', 'eu-west-2', 'uksouth', 'ukwest', 'europe-west2', 'tencent-uk'], location: countryCodeLocations.GB },
  { aliases: ['eu-paris', 'eu-west-3', 'francecentral', 'francesouth', 'europe-west9'], location: countryCodeLocations.FR },
  { aliases: ['eu-amsterdam', 'eu-west-1', 'west europe', 'westeurope', 'europe-west1', 'europe-west4'], location: countryCodeLocations.NL },
  { aliases: ['us-ashburn', 'na-ashburn', 'us-east-1', 'us-east4', 'us-east5', 'east us', 'eastus', 'iad', 'us-virginia', 'us-virginia-ashburn', 'virginia-ashburn'], location: { lat: 39.0438, lng: -77.4874, countryId: '840', matched: true } },
  { aliases: ['us-la', 'us-lax', 'lax', 'los angeles', 'us-los angeles', 'united states-los angeles', 'us-california-los angeles', 'california-los angeles', '洛杉矶', '洛杉磯', 'ロサンゼルス'], location: { lat: 34.0522, lng: -118.2437, countryId: '840', matched: true } },
  { aliases: ['us-ny', 'us-nyc', 'nyc', 'new york', 'us-new york', 'united states-new york', '纽约', '紐約', 'ニューヨーク'], location: { lat: 40.7128, lng: -74.006, countryId: '840', matched: true } },
  { aliases: ['us-sf', 'us-sfo', 'us-sjc', 'sfo', 'sjc', 'san francisco', 'san jose', 'silicon valley', 'us-siliconvalley', 'na-siliconvalley', 'us-silicon valley', '旧金山', '舊金山', '圣何塞', '聖荷西', '硅谷', 'シリコンバレー', 'サンフランシスコ'], location: { lat: 37.3382, lng: -121.8863, countryId: '840', matched: true } },
  { aliases: ['us-seattle', 'sea', 'seattle', 'us-oregon', 'oregon', 'us-west-1', 'us-west-2', 'us-west1', 'us-west2', 'us-west3', 'us-west4', 'west us', 'westus', 'us-california', '西雅图', '西雅圖', 'シアトル'], location: { lat: 45.5152, lng: -122.6784, countryId: '840', matched: true } },
  { aliases: ['us-central1', 'us-south', 'us-dallas', 'dfw'], location: { lat: 39.8283, lng: -98.5795, countryId: '840', matched: true } },
  { aliases: ['ca-toronto', 'canadacentral', 'canadaeast', 'northamerica-northeast1', 'northamerica-northeast2'], location: countryCodeLocations.CA },
  { aliases: ['sa-saopaulo', 'sa-east-1', 'brazilsouth', 'southamerica-east1', 'southamerica-west1'], location: countryCodeLocations.BR },
  { aliases: ['me-dubai', 'me-abudhabi', 'me-west1'], location: { lat: 25.2048, lng: 55.2708, countryId: '784', matched: true } },
  { aliases: ['hk', 'hkg', 'hong kong', 'hongkong', 'hong kong sar', 'hk-hongkong', 'cn-hongkong', '香港', 'ホンコン'], location: countryCodeLocations.HK },
  { aliases: ['shanghai', 'cn-shanghai', 'east china', 'huadong', '上海', '华东'], location: countryCodeLocations.CN },
  { aliases: ['beijing', 'cn-beijing', 'cn-north', 'north china', 'huabei', '北京', '华北'], location: { lat: 39.9042, lng: 116.4074, countryId: '156' } },
  { aliases: ['shenzhen', 'guangzhou', 'cn-south', 'south china', 'huanan', '深圳', '广州', '华南'], location: { lat: 22.5431, lng: 114.0579, countryId: '156' } },
  { aliases: ['chengdu', 'chongqing', 'cn-west', 'southwest china', '成都', '重庆'], location: { lat: 30.5728, lng: 104.0668, countryId: '156' } },
  { aliases: ['singapore', 'sg', 'sgp', 'ap-southeast-1', 'southeast asia', '新加坡', 'シンガポール'], location: { lat: 1.3521, lng: 103.8198, countryId: '702' } },
  { aliases: ['taiwan', 'tw', 'taipei', 'ap-taipei', '台北', '台湾', '臺灣'], location: countryCodeLocations.TW },
  { aliases: ['tokyo', 'japan', 'jp', 'ap-northeast-1', '东京', '東京', '日本'], location: { lat: 35.6762, lng: 139.6503, countryId: '392' } },
  { aliases: ['seoul', 'korea', 'kr', 'ap-northeast-2', '首尔', '首爾', '韩国', '韓國', 'ソウル'], location: { lat: 37.5665, lng: 126.978, countryId: '410' } },
  { aliases: ['mumbai', 'india', 'ap-south-1', '孟买', '印度'], location: { lat: 19.076, lng: 72.8777, countryId: '356' } },
  { aliases: ['sydney', 'australia', 'ap-southeast-2', 'australia east', '悉尼', '澳大利亚'], location: { lat: -33.8688, lng: 151.2093, countryId: '036' } },
  { aliases: ['frankfurt', 'germany', 'eu-central-1', '法兰克福', '德国'], location: { lat: 50.1109, lng: 8.6821, countryId: '276' } },
  { aliases: ['london', 'uk', 'united kingdom', 'eu-west-2', '伦敦', '英国'], location: { lat: 51.5072, lng: -0.1276, countryId: '826' } },
  { aliases: ['ireland', 'dublin', 'eu-west-1', '爱尔兰', '都柏林'], location: { lat: 53.3498, lng: -6.2603, countryId: '372' } },
  { aliases: ['paris', 'france', 'eu-west-3', '巴黎', '法国'], location: { lat: 48.8566, lng: 2.3522, countryId: '250' } },
  { aliases: ['amsterdam', 'netherlands', 'west europe', 'westeurope', '阿姆斯特丹', '荷兰'], location: { lat: 52.3676, lng: 4.9041, countryId: '528' } },
  { aliases: ['stockholm', 'sweden', 'eu-north-1', '斯德哥尔摩', '瑞典'], location: { lat: 59.3293, lng: 18.0686, countryId: '752' } },
  { aliases: ['virginia', 'ashburn', 'n-virginia', 'north virginia', 'us-east-1', 'east us', 'eastus', 'newark', 'buffalo', '美东', '美東', '米东', '米東', '弗吉尼亚'], location: { lat: 39.0438, lng: -77.4874, countryId: '840' } },
  { aliases: ['ohio', 'us-east-2', 'central us', 'centralus', '俄亥俄'], location: { lat: 40.4173, lng: -82.9071, countryId: '840' } },
  { aliases: ['california', 'oregon', 'los angeles', 'san francisco', 'san jose', 'seattle', 'las vegas', 'us-west', 'us-west-1', 'us-west-2', 'westus', '美西', '米西', '加州'], location: { lat: 37.7749, lng: -122.4194, countryId: '840' } },
  { aliases: ['dallas', 'houston', 'chicago', 'atlanta', 'miami', 'phoenix', 'denver', 'us-central', 'us-south'], location: { lat: 39.8283, lng: -98.5795, countryId: '840' } },
  { aliases: ['canada', 'toronto', 'canadacentral', '加拿大', '多伦多'], location: { lat: 43.6532, lng: -79.3832, countryId: '124' } },
  { aliases: ['sao paulo', 'brazil', 'sa-east-1', 'brazilsouth', '圣保罗', '巴西'], location: { lat: -23.5558, lng: -46.6396, countryId: '076' } },
  { aliases: ['dubai', 'uae', 'me-central', 'middle east', '迪拜', '阿联酋'], location: { lat: 25.2048, lng: 55.2708, countryId: '784' } },
  { aliases: ['cape town', 'south africa', 'af-south-1', '开普敦', '南非'], location: { lat: -33.9249, lng: 18.4241, countryId: '710' } },
  { aliases: ['us', 'usa', 'u-s', 'u-s-a', 'united states', 'united states of america', 'america', '美国', '美國', '米国', 'アメリカ'], location: { lat: 39.8283, lng: -98.5795, countryId: '840' } },
];
const normalizedRegionLocations = regionLocations.map(({ aliases, location }) => ({
  location,
  aliases: aliases.map((alias) => normalizeRegion(alias)),
}));

const fallbackLocation: RegionLocation = { lat: 18, lng: 0, countryId: '', matched: false };

export function MonitoringOverview({ servers, events, onlineCount, avgCpu, onRegionServersOpen }: MonitoringOverviewProps) {
  const { language, t } = useI18n();
  const providerName = (provider: string) => formatProviderName(provider, t);
  const regionName = (region: string) => formatRegionName(region, language);
  const countryName = (country: string) => formatCountryName(country, language);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressMapClickRef = useRef(false);
  const [mapView, setMapView] = useState({ scale: 1, x: 0, y: 0 });
  const [selectedRegionName, setSelectedRegionName] = useState('');
  const [hoveredCountry, setHoveredCountry] = useState<CountryHover | null>(null);
  const [pinnedCountry, setPinnedCountry] = useState<CountryHover | null>(null);
  const overviewStats = useMemo(() => buildOverviewStats(servers, events), [events, servers]);
  const regions = useMemo(() => buildRegionNodes(servers), [servers]);
  const visibleRegions = useMemo(
    () => (regions.length ? regions : [buildEmptyRegionNode(t('overview.pendingRegion'), t('overview.noAssetProvider'))]),
    [regions, t],
  );
  const mapRegions = useMemo(() => (regions.length ? regions : []), [regions]);
  const activeCountryIds = useMemo(() => new Set(mapRegions.flatMap((region) => region.countryIds)), [mapRegions]);
  const regionsByCountryId = useMemo(() => buildCountryRegionMap(mapRegions), [mapRegions]);
  const selectedRegion = visibleRegions.find((region) => region.region === selectedRegionName) ?? visibleRegions[0];
  const visibleCountryPopup = hoveredCountry ?? pinnedCountry;
  const visibleTooltipAnchor = visibleCountryPopup ? getTooltipViewportAnchor(visibleCountryPopup) : null;
  const tooltipIsPinned = Boolean(pinnedCountry && visibleCountryPopup && pinnedCountry.title === visibleCountryPopup.title);
  const { openEvents, criticalEvents, warningServers, connectedServers, providerCount, busiestServers } = overviewStats;

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!mapElement) {
      return undefined;
    }

    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomMap(event.deltaY < 0 ? 0.12 : -0.12);
    };

    mapElement.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => mapElement.removeEventListener('wheel', handleNativeWheel);
  }, []);

  useEffect(() => {
    const mapElement = mapRef.current;
    if (!mapElement) {
      return undefined;
    }

    const settleMapView = () => {
      dragRef.current = null;
      setMapView((current) => clampMapPan(current));
    };

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(settleMapView) : null;
    observer?.observe(mapElement);
    window.addEventListener('orientationchange', settleMapView);
    window.addEventListener('resize', settleMapView);

    return () => {
      observer?.disconnect();
      window.removeEventListener('orientationchange', settleMapView);
      window.removeEventListener('resize', settleMapView);
    };
  }, []);

  useEffect(() => {
    if (!regions.length) {
      setHoveredCountry(null);
      setPinnedCountry(null);
      setSelectedRegionName('');
      setMapView((current) => clampMapPan(current));
      return;
    }

    if (selectedRegionName && !regions.some((region) => region.region === selectedRegionName)) {
      setSelectedRegionName(regions[0].region);
    }
  }, [regions, selectedRegionName]);

  return (
    <section className="monitor-overview" aria-labelledby="overview-title">
      <div className="monitor-hero">
        <div className="monitor-heading">
          <p>{t('overview.eyebrow')}</p>
          <h1 id="overview-title">{t('overview.title')}</h1>
        </div>
        <div className="monitor-kpis" aria-label={t('nav.overview')}>
          <div>
            <span><Wifi size={15} /> {t('overview.kpiOnline')}</span>
            <strong>{onlineCount}/{servers.length}</strong>
          </div>
          <div>
            <span><Activity size={15} /> {t('overview.kpiAvgCpu')}</span>
            <strong>{avgCpu}%</strong>
          </div>
          <div>
            <span><AlertTriangle size={15} /> {t('overview.kpiCritical')}</span>
            <strong>{criticalEvents}</strong>
          </div>
          <div>
            <span><ShieldCheck size={15} /> SSH</span>
            <strong>{connectedServers}</strong>
          </div>
        </div>
      </div>

      <div className="monitor-layout">
        <div className="monitor-map-panel">
          <div className="panel-title">
            <span><Globe2 size={17} /> {t('overview.mapTitle')}</span>
            <small>{t('overview.regionCount', { count: regions.length })}</small>
          </div>
          <div
            ref={mapRef}
            className={['cloud-map nezha-map', mapView.scale > 1.01 ? 'is-zoomed' : ''].filter(Boolean).join(' ')}
            role="application"
            aria-label={t('overview.mapAria')}
            onPointerDown={handleMapPointerDown}
            onPointerMove={handleMapPointerMove}
            onPointerUp={handleMapPointerEnd}
            onPointerCancel={handleMapPointerEnd}
            onPointerLeave={handleMapPointerLeave}
            onClick={(event) => {
              if (suppressMapClickRef.current) {
                event.stopPropagation();
                return;
              }

              const target = event.target as HTMLElement;
              if (!target.closest('.map-country.active') && !target.closest('.map-tooltip') && !target.closest('button')) {
                setPinnedCountry(null);
              }
            }}
          >
            <div className="map-caption">{t('overview.mapDistribution', { count: regions.length })}</div>
            <div
              className="map-transform-layer"
              style={{ transform: `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})` }}
            >
              <svg className="world-map-svg" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <defs>
                  <filter id="map-glow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <rect className="map-ocean" width={MAP_WIDTH} height={MAP_HEIGHT} rx="10" />
                <g className="map-countries">
                  {mapCountryShapes.map((country) => {
                    const id = country.id;
                    const matchedRegions = regionsByCountryId.get(id) ?? [];
                    const matchedRegion = matchedRegions[0];
                    const countryHover = matchedRegion ? buildCountryHover(country, matchedRegions, id, regionName, countryName) : null;
                    const countryClass = [
                      activeCountryIds.has(id) ? 'map-country active' : 'map-country',
                      matchedRegions.some((region) => region.region === selectedRegion.region) ? 'selected' : '',
                    ].filter(Boolean).join(' ');

                    return (
                      <path
                        key={id || country.name}
                        d={country.path}
                        className={countryClass}
                        role={matchedRegion ? 'button' : undefined}
                        tabIndex={matchedRegion ? 0 : undefined}
                        aria-label={countryHover ? `${countryHover.title}: ${t('overview.countrySummary', { total: countryHover.total, running: countryHover.running })}` : undefined}
                        aria-pressed={matchedRegions.some((region) => region.region === selectedRegion.region) ? true : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (suppressMapClickRef.current) {
                            return;
                          }
                          if (matchedRegion && countryHover) {
                            setSelectedRegionName(matchedRegion.region);
                            setHoveredCountry(null);
                            setPinnedCountry(countryHover);
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.key === 'Enter' || event.key === ' ') && matchedRegion && countryHover) {
                            event.preventDefault();
                            setSelectedRegionName(matchedRegion.region);
                            setHoveredCountry(null);
                            setPinnedCountry(countryHover);
                          }
                          if (event.key === 'Escape') {
                            setPinnedCountry(null);
                            setHoveredCountry(null);
                          }
                        }}
                        onFocus={() => {
                          if (matchedRegion && countryHover) {
                            setSelectedRegionName(matchedRegion.region);
                            setHoveredCountry(countryHover);
                          }
                        }}
                        onBlur={() => setHoveredCountry(null)}
                        onMouseEnter={() => {
                          if (countryHover) {
                            setHoveredCountry(countryHover);
                          }
                        }}
                        onMouseLeave={() => setHoveredCountry(null)}
                      />
                    );
                  })}
                </g>
              </svg>
            </div>
            {visibleCountryPopup && (
              <div
                className={[
                  tooltipIsPinned ? 'map-tooltip pinned' : 'map-tooltip',
                  (visibleTooltipAnchor?.x ?? visibleCountryPopup.x) > 64 ? 'flip-x' : '',
                  (visibleTooltipAnchor?.y ?? visibleCountryPopup.y) > 72 ? 'flip-y' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  left: `${clamp(visibleTooltipAnchor?.x ?? visibleCountryPopup.x, 8, 92)}%`,
                  top: `${clamp(visibleTooltipAnchor?.y ?? visibleCountryPopup.y, 12, 82)}%`,
                }}
              >
                <strong>{visibleCountryPopup.title}</strong>
                <span>{[visibleCountryPopup.countryName, t('overview.countrySummary', { total: visibleCountryPopup.total, running: visibleCountryPopup.running })].join(' / ')}</span>
                <ul>
                  {visibleCountryPopup.serverNames.slice(0, 6).map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
                {tooltipIsPinned && (
                  <button
                    type="button"
                    className="map-tooltip-action"
                    aria-label={`${t('overview.viewRegionServers')}: ${visibleCountryPopup.title}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      openRegionServers(visibleCountryPopup);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        openRegionServers(visibleCountryPopup);
                      }
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {t('overview.viewRegionServers')}
                  </button>
                )}
              </div>
            )}
            <div className="map-vignette" aria-hidden="true" />
            <div className="map-controls" aria-label={t('overview.mapControls')}>
              <button type="button" aria-label={t('overview.zoomIn')} title={t('overview.zoomIn')} onClick={() => zoomMap(0.2)}>
                <Plus size={14} />
              </button>
              <button type="button" aria-label={t('overview.zoomOut')} title={t('overview.zoomOut')} onClick={() => zoomMap(-0.2)}>
                <Minus size={14} />
              </button>
              <button type="button" aria-label={t('overview.resetMap')} title={t('overview.resetMap')} onClick={resetMap}>
                <RotateCcw size={14} />
              </button>
              <button type="button" aria-label={t('overview.focusRegion')} title={t('overview.focusRegion')} onClick={() => focusRegion(selectedRegion)}>
                <LocateFixed size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="monitor-side">
          <article className="monitor-card">
            <div className="panel-title">
              <span><Network size={17} /> {t('overview.regionLoad')}</span>
              <small>{t('overview.warningServers', { count: warningServers })}</small>
            </div>
            <div className="region-list">
              {visibleRegions.map((region) => (
                <button
                  key={region.region}
                  type="button"
                  className="region-row"
                  aria-label={`${t('overview.focusRegion')}: ${regionName(region.region)}`}
                  onClick={() => focusRegion(region)}
                >
                  <div>
                    <strong>{regionName(region.region)}</strong>
                    <span>{region.providers.map(providerName).join(' / ')}</span>
                  </div>
                  <div>
                    <b>{region.avgCpu}%</b>
                    <small>{region.running}/{region.total}</small>
                  </div>
                </button>
              ))}
            </div>
          </article>

          <article className="monitor-card">
            <div className="panel-title">
              <span><AlertTriangle size={17} /> {t('overview.eventSummary')}</span>
              <small>{t('overview.openEvents', { count: openEvents.length })}</small>
            </div>
            <div className="event-mini-list">
              {openEvents.slice(0, 4).map((event) => (
                <div key={event.id} className={`event-mini ${event.severity}`}>
                  <strong>{event.title}</strong>
                  <span>{[event.source, statusLabel(event.status, language)].join(' / ')}</span>
                </div>
              ))}
              {!openEvents.length && <div className="quiet-state">{t('overview.noOpenEvents')}</div>}
            </div>
          </article>
        </div>
      </div>

      <div className="monitor-bottom">
        <article className="monitor-card">
          <div className="panel-title">
            <span><Server size={17} /> {t('overview.resourceRank')}</span>
            <small>{t('overview.serverCount', { count: servers.length })}</small>
          </div>
          <div className="server-load-list">
            {busiestServers.map((server) => {
              const load = Math.max(server.cpu, server.memory, server.disk);
              return (
                <div key={server.id} className="server-load-row">
                  <div>
                    <strong>{server.name}</strong>
                    <span>{[providerName(server.provider), regionName(server.region)].join(' / ')}</span>
                  </div>
                  <div className="load-meter">
                    <span className={percentClass(load)} style={{ width: `${load}%` }} />
                  </div>
                  <b>{load}%</b>
                </div>
              );
            })}
            {!busiestServers.length && <div className="quiet-state">{t('overview.noServerRank')}</div>}
          </div>
        </article>

        <article className="monitor-card">
          <div className="panel-title">
            <span><MapPin size={17} /> {t('overview.coverage')}</span>
            <small>{t('overview.providerCount', { count: providerCount })}</small>
          </div>
          <div className="coverage-grid">
            <div>
              <strong>{servers.length}</strong>
              <span>{t('overview.assetTotal')}</span>
            </div>
            <div>
              <strong>{connectedServers}</strong>
              <span>{t('overview.sshVerified')}</span>
            </div>
            <div>
              <strong>{warningServers}</strong>
              <span>{t('overview.warningServer')}</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );

  function handleMapPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button, .map-tooltip, .map-country.active')) {
      return;
    }
    if (event.pointerType === 'touch' && mapView.scale <= 1.01) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: mapView.x,
      originY: mapView.y,
      moved: false,
    };
  }

  function handleMapPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) > 5) {
      drag.moved = true;
    }

    setMapView((current) => ({
      ...current,
      ...clampMapPan({
        x: drag.originX + deltaX,
        y: drag.originY + deltaY,
        scale: current.scale,
      }),
    }));
  }

  function handleMapPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      suppressMapClickRef.current = drag.moved;
      dragRef.current = null;
      if (suppressMapClickRef.current) {
        window.setTimeout(() => {
          suppressMapClickRef.current = false;
        }, 0);
      }
    }
  }

  function handleMapPointerLeave(event: ReactPointerEvent<HTMLDivElement>) {
    setHoveredCountry(null);
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    suppressMapClickRef.current = drag.moved;
    if (suppressMapClickRef.current) {
      window.setTimeout(() => {
        suppressMapClickRef.current = false;
      }, 0);
    }
  }

  function zoomMap(delta: number) {
    setMapView((current) => ({
      ...clampMapPan({
        ...current,
        scale: clamp(Number((current.scale + delta).toFixed(2)), 1, 2.4),
      }),
    }));
  }

  function resetMap() {
    setMapView({ scale: 1, x: 0, y: 0 });
  }

  function focusRegion(region: RegionNode) {
    const nextView = getFocusedMapView(region, Math.max(1.55, mapView.scale));
    setSelectedRegionName(region.region);
    setPinnedCountry(buildRegionHover(region, regionName));
    setHoveredCountry(null);
    setMapView(clampMapPan(nextView));
  }

  function openRegionServers(country: CountryHover) {
    onRegionServersOpen?.(country.regions.map((region) => region.region));
  }

  function getFocusedMapView(region: RegionNode, scale: number) {
    const mapElement = mapRef.current;
    const width = mapElement?.clientWidth ?? 720;
    const height = mapElement?.clientHeight ?? 360;

    return {
      scale,
      x: Math.round(((50 - region.x) / 100) * width),
      y: Math.round(((50 - region.y) / 100) * height),
    };
  }

  function clampMapPan(view: { x: number; y: number; scale: number }) {
    const bounds = getMapPanBounds(view.scale);
    return {
      scale: view.scale,
      x: clamp(view.x, -bounds.x, bounds.x),
      y: clamp(view.y, -bounds.y, bounds.y),
    };
  }

  function getMapPanBounds(scale: number) {
    const mapElement = mapRef.current;
    const width = mapElement?.clientWidth ?? 720;
    const height = mapElement?.clientHeight ?? 360;
    const zoomOverflow = Math.max(0, scale - 1);
    return {
      x: Math.round((width * zoomOverflow) / 2),
      y: Math.round((height * zoomOverflow) / 2),
    };
  }

  function getTooltipViewportAnchor(country: CountryHover) {
    const mapElement = mapRef.current;
    const width = Math.max(1, mapElement?.clientWidth ?? 720);
    const height = Math.max(1, mapElement?.clientHeight ?? 360);

    return {
      x: clamp(50 + (country.x - 50) * mapView.scale + (mapView.x / width) * 100, 0, 100),
      y: clamp(50 + (country.y - 50) * mapView.scale + (mapView.y / height) * 100, 0, 100),
    };
  }
}

function buildRegionNodes(servers: ServerNode[]): RegionNode[] {
  const groups = new Map<string, {
    total: number;
    running: number;
    warning: number;
    cpuTotal: number;
    providers: Set<string>;
    serverNames: string[];
  }>();
  servers.forEach((server) => {
    let group = groups.get(server.region);
    if (!group) {
      group = {
        total: 0,
        running: 0,
        warning: 0,
        cpuTotal: 0,
        providers: new Set<string>(),
        serverNames: [],
      };
      groups.set(server.region, group);
    }
    group.total += 1;
    group.running += server.status === 'running' ? 1 : 0;
    group.warning += server.status === 'warning' ? 1 : 0;
    group.cpuTotal += server.cpu;
    group.providers.add(server.provider);
    if (group.serverNames.length < tooltipServerNameLimit) {
      group.serverNames.push(server.name);
    }
  });

  return Array.from(groups.entries()).map(([region, group], index) => {
    const location = resolveRegionLocation(region, index);
    const position = projectRegion(location);

    return {
      region,
      total: group.total,
      running: group.running,
      warning: group.warning,
      avgCpu: Math.round(group.cpuTotal / group.total),
      providers: Array.from(group.providers).slice(0, 3),
      serverNames: group.serverNames,
      lat: location.lat,
      lng: location.lng,
      countryIds: getRenderableCountryIds(location),
      x: position.x,
      y: position.y,
    };
  });
}

function buildCountryRegionMap(regions: RegionNode[]) {
  const map = new Map<string, RegionNode[]>();
  regions.forEach((region) => {
    region.countryIds.forEach((countryId) => {
      const list = map.get(countryId) ?? [];
      list.push(region);
      map.set(countryId, list);
    });
  });
  return map;
}

function buildOverviewStats(servers: ServerNode[], events: OperationEvent[]) {
  const openEvents = [];
  let criticalEvents = 0;
  let warningServers = 0;
  let connectedServers = 0;
  const providers = new Set<string>();
  const busiestServers: Array<{ server: ServerNode; load: number }> = [];

  for (const event of events) {
    if (event.status !== 'open') {
      continue;
    }
    openEvents.push(event);
    if (event.severity === 'critical') {
      criticalEvents += 1;
    }
  }

  for (const server of servers) {
    providers.add(server.provider);
    if (server.status === 'warning') {
      warningServers += 1;
    }
    if (server.ssh?.connected) {
      connectedServers += 1;
    }

    const load = Math.max(server.cpu, server.memory, server.disk);
    const insertAt = busiestServers.findIndex((item) => load > item.load);
    if (insertAt >= 0) {
      busiestServers.splice(insertAt, 0, { server, load });
    } else if (busiestServers.length < 5) {
      busiestServers.push({ server, load });
    }
    if (busiestServers.length > 5) {
      busiestServers.length = 5;
    }
  }

  return {
    openEvents,
    criticalEvents,
    warningServers,
    connectedServers,
    providerCount: providers.size,
    busiestServers: busiestServers.map((item) => item.server),
  };
}

function buildCountryHover(
  country: MapCountryShape,
  regions: RegionNode[],
  countryId: string,
  formatRegion: (region: string) => string,
  formatCountry: (country: string) => string,
): CountryHover {
  const total = regions.reduce((sum, region) => sum + region.total, 0);
  const running = regions.reduce((sum, region) => sum + region.running, 0);
  const fallbackRegion = regions[0];
  const regionNames = regions.map((region) => formatRegion(region.region));
  const weightedTotal = Math.max(1, regions.reduce((sum, region) => sum + region.total, 0));
  const regionAnchor = {
    x: regions.reduce((sum, region) => sum + region.x * region.total, 0) / weightedTotal,
    y: regions.reduce((sum, region) => sum + region.y * region.total, 0) / weightedTotal,
  };
  const countryAnchor = {
    x: Number.isFinite(country.centroid[0]) ? (country.centroid[0] / MAP_WIDTH) * 100 : fallbackRegion.x,
    y: Number.isFinite(country.centroid[1]) ? (country.centroid[1] / MAP_HEIGHT) * 100 : fallbackRegion.y,
  };
  const x = clamp(Number.isFinite(regionAnchor.x) ? regionAnchor.x : countryAnchor.x, 4, 96);
  const y = clamp(Number.isFinite(regionAnchor.y) ? regionAnchor.y : countryAnchor.y, 6, 92);

  return {
    countryName: formatCountry(country.name || fallbackRegion.region || countryId),
    title: regionNames.length > 2 ? `${regionNames.slice(0, 2).join(' / ')} +${regionNames.length - 2}` : regionNames.join(' / '),
    regions,
    total,
    running,
    serverNames: collectTooltipServerNames(regions),
    x,
    y,
  };
}

function buildRegionHover(region: RegionNode, formatRegion: (region: string) => string): CountryHover {
  return {
    countryName: region.providers.join(' / '),
    title: formatRegion(region.region),
    regions: [region],
    total: region.total,
    running: region.running,
    serverNames: region.serverNames.slice(0, tooltipServerNameLimit),
    x: region.x,
    y: region.y,
  };
}

function collectTooltipServerNames(regions: RegionNode[]) {
  const names: string[] = [];
  for (const region of regions) {
    for (const name of region.serverNames) {
      names.push(name);
      if (names.length >= tooltipServerNameLimit) {
        return names;
      }
    }
  }
  return names;
}

function buildEmptyRegionNode(regionLabel: string, providerLabel: string): RegionNode {
  const location = resolveRegionLocation('hong kong', 0);
  const position = projectRegion(location);

  return {
    region: regionLabel,
    total: 0,
    running: 0,
    warning: 0,
    avgCpu: 0,
    providers: [providerLabel],
    serverNames: [],
    lat: location.lat,
    lng: location.lng,
    countryIds: [location.countryId],
    x: position.x,
    y: position.y,
    placeholder: true,
  };
}

function formatProviderName(provider: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  return provider.trim().toLowerCase() === 'custom' ? t('servers.providerCustomDisplay') : provider;
}

function resolveRegionLocation(region: string, _index: number): RegionLocation {
  const normalizedRegions = buildRegionSearchVariants(region);
  const exactMatch = normalizedRegionLocations.find(({ aliases }) => aliases.some((alias) => normalizedRegions.includes(alias)));
  const partialMatch = normalizedRegionLocations.find(({ aliases }) => aliases.some((alias) => normalizedRegions.some((normalizedRegion) => regionHasAlias(normalizedRegion, alias))));
  const countryCodeLocation = normalizedRegions.map(resolveCountryCodeLocation).find(Boolean);

  return exactMatch?.location ?? partialMatch?.location ?? countryCodeLocation ?? fallbackLocation;
}

function normalizeRegion(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[']/g, '')
    .replace(/[_.,/]+/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRegionSearchVariants(region: string): string[] {
  const normalizedRegion = normalizeRegion(region);
  const variants = new Set([normalizedRegion]);
  const countryNormalized = normalizedRegion
    .replace(/\bunited states of america\b/g, 'us')
    .replace(/\bunited states\b/g, 'us')
    .replace(/\bu-s-a\b/g, 'us')
    .replace(/\bu-s\b/g, 'us')
    .replace(/\busa\b/g, 'us')
    .replace(/\bamerica\b/g, 'us')
    .replace(/美国|美國|米国|アメリカ/g, 'us')
    .replace(/\bunited kingdom\b/g, 'uk')
    .replace(/\bgreat britain\b/g, 'uk')
    .replace(/\bbritain\b/g, 'uk')
    .replace(/\bmainland china\b/g, 'cn')
    .replace(/\bpeoples republic of china\b/g, 'cn')
    .replace(/\bprc\b/g, 'cn');
  variants.add(countryNormalized);

  const regionTokens = tokenizeRegion(countryNormalized);
  const splitRegionTokens = countryNormalized.split(/[-\s/]+/).filter(Boolean);
  if (splitRegionTokens.length > regionTokens.length) {
    variants.add(splitRegionTokens.join(' '));
  }
  addShortRegionVariants(variants, regionTokens);
  addShortRegionVariants(variants, splitRegionTokens);

  return Array.from(variants).filter(Boolean);
}

function addShortRegionVariants(variants: Set<string>, tokens: string[]) {
  if (!tokens.includes('us')) {
    return;
  }

  const expandedTokens = tokens.map((token) => shortRegionExpansions[token] ?? token);
  if (expandedTokens.join('-') !== tokens.join('-')) {
    variants.add(expandedTokens.join('-'));
    variants.add(expandedTokens.join(' '));
  }
}

function regionHasAlias(normalizedRegion: string, normalizedAlias: string): boolean {
  if (!normalizedRegion || !normalizedAlias) {
    return false;
  }

  const tokens = tokenizeRegion(normalizedRegion);
  const aliasTokens = tokenizeRegion(normalizedAlias);
  if (aliasTokens.length === 1 && aliasTokens[0].length <= 2) {
    return tokens.includes(aliasTokens[0]);
  }

  return normalizedRegion.includes(normalizedAlias) || containsTokenSequence(tokens, aliasTokens);
}

function tokenizeRegion(value: string): string[] {
  return value.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

function containsTokenSequence(tokens: string[], aliasTokens: string[]): boolean {
  if (!tokens.length || !aliasTokens.length || aliasTokens.length > tokens.length) {
    return false;
  }

  return tokens.some((_, index) => aliasTokens.every((token, offset) => tokens[index + offset] === token));
}

function resolveCountryCodeLocation(normalizedRegion: string) {
  const match = normalizedRegion.match(/^([a-z]{2})(?:\b|[-\s/])/);
  if (!match) {
    return undefined;
  }

  return countryCodeLocations[match[1].toUpperCase()];
}

function getRenderableCountryIds(location: RegionLocation) {
  return [location.countryId, ...(location.countryIds ?? [])]
    .map(normalizeCountryId)
    .filter((countryId, index, countryIds) => countryId !== '000' && countryIds.indexOf(countryId) === index)
    .filter((countryId) => mapCountryIds.has(countryId));
}

function projectRegion(location: RegionLocation): { x: number; y: number } {
  const [projectedX, projectedY] = projection([location.lng, location.lat]) ?? [MAP_WIDTH / 2, MAP_HEIGHT / 2];

  return {
    x: clamp((projectedX / MAP_WIDTH) * 100, 3, 97),
    y: clamp((projectedY / MAP_HEIGHT) * 100, 6, 94),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeCountryId(id: string | number | undefined) {
  return String(id ?? '').padStart(3, '0');
}
