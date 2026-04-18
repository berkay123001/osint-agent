/**
 * GPX Analyzer Tool — GPS track analysis for OSINT investigations.
 * Parses GPX files, calculates geographic center, identifies repeated locations,
 * reverse-geocodes coordinates to identify landmarks, cities, and addresses.
 *
 * Use cases:
 * - Fitness tracker data analysis (Strava, Garmin, etc.)
 * - GPS route forensic analysis
 * - Location pattern identification from exported tracks
 * - Reverse geocoding coordinates to real-world landmarks
 */

import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { logger } from '../lib/logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TrackPoint {
  lat: number
  lon: number
  ele: number | null
  time: string | null
}

interface Track {
  name: string
  type: string | null
  points: TrackPoint[]
}

interface GpxMetadata {
  name: string | null
  time: string | null
  creator: string | null
}

interface GpxFile {
  filename: string
  metadata: GpxMetadata
  tracks: Track[]
}

interface GeoCenter {
  lat: number
  lon: number
}

interface ReverseGeocodeResult {
  displayName: string
  city: string | null
  country: string | null
  countryCode: string | null
  road: string | null
  suburb: string | null
  landmark: string | null
  raw: Record<string, unknown>
}

interface Hotspot {
  lat: number
  lon: number
  visitCount: number
  percentageOfTracks: number
  geocode: ReverseGeocodeResult | null
}

export interface GpxAnalysisResult {
  files: GpxFile[]
  totalPoints: number
  totalTracks: number
  geographicCenter: GeoCenter
  centerGeocode: ReverseGeocodeResult | null
  hotspots: Hotspot[]
  boundingBox: { minLat: number; maxLat: number; minLon: number; maxLon: number }
  errors: string[]
}

// ─── GPX Parser ─────────────────────────────────────────────────────────────

function parseGpx(xml: string, filename: string): GpxFile {
  const result: GpxFile = {
    filename,
    metadata: { name: null, time: null, creator: null },
    tracks: [],
  }

  // Extract metadata name
  const metaNameMatch = xml.match(/<metadata>[\s\S]*?<name>([^<]+)<\/name>/)
  if (metaNameMatch) result.metadata.name = metaNameMatch[1]

  const metaTimeMatch = xml.match(/<metadata>[\s\S]*?<time>([^<]+)<\/time>/)
  if (metaTimeMatch) result.metadata.time = metaTimeMatch[1]

  const creatorMatch = xml.match(/creator="([^"]+)"/)
  if (creatorMatch) result.metadata.creator = creatorMatch[1]

  // Extract tracks
  const trkRegex = /<trk>([\s\S]*?)<\/trk>/g
  let trkMatch: RegExpExecArray | null

  while ((trkMatch = trkRegex.exec(xml)) !== null) {
    const trkBlock = trkMatch[1]

    const trkNameMatch = trkBlock.match(/<name>([^<]+)<\/name>/)
    const trkTypeMatch = trkBlock.match(/<type>([^<]+)<\/type>/)

    const track: Track = {
      name: trkNameMatch?.[1] ?? 'Unnamed Track',
      type: trkTypeMatch?.[1] ?? null,
      points: [],
    }

    // Extract track points
    const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g
    let ptMatch: RegExpExecArray | null

    while ((ptMatch = trkptRegex.exec(trkBlock)) !== null) {
      const lat = parseFloat(ptMatch[1])
      const lon = parseFloat(ptMatch[2])
      const ptBody = ptMatch[3]

      let ele: number | null = null
      let time: string | null = null

      const eleMatch = ptBody.match(/<ele>([^<]+)<\/ele>/)
      if (eleMatch) ele = parseFloat(eleMatch[1])

      const timeMatch = ptBody.match(/<time>([^<]+)<\/time>/)
      if (timeMatch) time = timeMatch[1]

      if (!isNaN(lat) && !isNaN(lon)) {
        track.points.push({ lat, lon, ele, time })
      }
    }

    result.tracks.push(track)
  }

  return result
}

// ─── Geographic Calculations ────────────────────────────────────────────────

function calculateCenter(points: TrackPoint[]): GeoCenter {
  let sumLat = 0
  let sumLon = 0
  for (const p of points) {
    sumLat += p.lat
    sumLon += p.lon
  }
  return {
    lat: +(sumLat / points.length).toFixed(6),
    lon: +(sumLon / points.length).toFixed(6),
  }
}

function haversineDistanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const calc = sinLat * sinLat + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLon * sinLon
  return R * 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc))
}

function findHotspots(
  files: GpxFile[],
  radiusKm: number = 0.05,
  minVisits: number = 2,
): Hotspot[] {
  const allPoints: { lat: number; lon: number; fileIdx: number }[] = []

  for (let fIdx = 0; fIdx < files.length; fIdx++) {
    for (const track of files[fIdx].tracks) {
      // Sample every 3rd point to reduce noise
      for (let i = 0; i < track.points.length; i += 3) {
        allPoints.push({
          lat: track.points[i].lat,
          lon: track.points[i].lon,
          fileIdx: fIdx,
        })
      }
    }
  }

  const visited = new Set<number>()
  const clusters: { lat: number; lon: number; points: typeof allPoints }[] = []

  for (let i = 0; i < allPoints.length; i++) {
    if (visited.has(i)) continue

    const cluster: typeof allPoints = [allPoints[i]]
    visited.add(i)

    for (let j = i + 1; j < allPoints.length; j++) {
      if (visited.has(j)) continue

      const dist = haversineDistanceKm(
        { lat: allPoints[i].lat, lon: allPoints[i].lon },
        allPoints[j],
      )

      if (dist <= radiusKm) {
        cluster.push(allPoints[j])
        visited.add(j)
      }
    }

    clusters.push({
      lat: cluster.reduce((s, p) => s + p.lat, 0) / cluster.length,
      lon: cluster.reduce((s, p) => s + p.lon, 0) / cluster.length,
      points: cluster,
    })
  }

  // Sort by cluster size (most visited first)
  clusters.sort((a, b) => b.points.length - a.points.length)

  // Return top hotspots
  return clusters
    .filter(c => c.points.length >= minVisits)
    .slice(0, 5)
    .map(c => ({
      lat: +c.lat.toFixed(6),
      lon: +c.lon.toFixed(6),
      visitCount: c.points.length,
      percentageOfTracks: +((c.points.length / allPoints.length) * 100).toFixed(1),
      geocode: null,
    }))
}

// ─── Reverse Geocoding ──────────────────────────────────────────────────────

async function reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&accept-language=en`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OSINT-Agent-GPX-Analyzer/1.0' },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return null

    const data = await res.json() as Record<string, unknown>
    const address = (data.address ?? {}) as Record<string, string>

    // Try to identify landmark from various fields
    let landmark: string | null = null
    if (data.name && typeof data.name === 'string' && data.name.length > 2) {
      landmark = data.name
    }
    if (address.tourism) landmark = address.tourism
    if (address.historic) landmark = address.historic
    if (address.leisure && address.leisure.includes('park')) landmark = address.leisure
    if (address.amenity && ['theatre', 'cinema', 'library', 'museum', 'arts_centre'].includes(address.amenity)) {
      landmark = address.amenity
    }

    return {
      displayName: data.display_name as string ?? '',
      city: address.city ?? address.town ?? address.village ?? null,
      country: address.country ?? null,
      countryCode: address.country_code ?? null,
      road: address.road ?? null,
      suburb: address.suburb ?? address.quarter ?? null,
      landmark,
      raw: data,
    }
  } catch {
    return null
  }
}

// ─── Main Analysis Function ─────────────────────────────────────────────────

export async function analyzeGpxFiles(filePaths: string[]): Promise<GpxAnalysisResult> {
  const errors: string[] = []
  const files: GpxFile[] = []
  const allPoints: TrackPoint[] = []

  for (const fp of filePaths) {
    const resolved = resolve(fp)
    try {
      const xml = await readFile(resolved, 'utf-8')
      const gpx = parseGpx(xml, resolved.split('/').pop() ?? resolved)

      if (gpx.tracks.length === 0) {
        errors.push(`${resolved}: No tracks found in GPX file`)
        continue
      }

      files.push(gpx)

      for (const track of gpx.tracks) {
        allPoints.push(...track.points)
      }

      logger.info('TOOL', `📍 GPX parse: ${gpx.metadata.name ?? gpx.filename} — ${gpx.tracks.reduce((s, t) => s + t.points.length, 0)} nokta`)
    } catch (e) {
      errors.push(`${resolved}: ${(e as Error).message}`)
    }
  }

  if (allPoints.length === 0) {
    return {
      files: [],
      totalPoints: 0,
      totalTracks: 0,
      geographicCenter: { lat: 0, lon: 0 },
      centerGeocode: null,
      hotspots: [],
      boundingBox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
      errors,
    }
  }

  // Calculate geographic center
  const geographicCenter = calculateCenter(allPoints)

  // Calculate bounding box
  const boundingBox = {
    minLat: Math.min(...allPoints.map(p => p.lat)),
    maxLat: Math.max(...allPoints.map(p => p.lat)),
    minLon: Math.min(...allPoints.map(p => p.lon)),
    maxLon: Math.max(...allPoints.map(p => p.lon)),
  }

  // Find hotspots (repeated locations)
  const hotspots = findHotspots(files)

  // Reverse geocode center point
  logger.info('TOOL', `🌍 Reverse geocode: ${geographicCenter.lat}, ${geographicCenter.lon}`)
  const centerGeocode = await reverseGeocode(geographicCenter.lat, geographicCenter.lon)

  // Reverse geocode top hotspots (max 3 to respect rate limits)
  for (let i = 0; i < Math.min(hotspots.length, 3); i++) {
    logger.info('TOOL', `🔥 Hotspot #${i + 1} geocode: ${hotspots[i].lat}, ${hotspots[i].lon}`)
    hotspots[i].geocode = await reverseGeocode(hotspots[i].lat, hotspots[i].lon)
    // Nominatim rate limit: 1 req/sec
    if (i < Math.min(hotspots.length, 3) - 1) {
      await new Promise(r => setTimeout(r, 1100))
    }
  }

  return {
    files,
    totalPoints: allPoints.length,
    totalTracks: files.reduce((s, f) => s + f.tracks.length, 0),
    geographicCenter,
    centerGeocode,
    hotspots,
    boundingBox,
    errors,
  }
}

// ─── Formatter ──────────────────────────────────────────────────────────────

export function formatGpxResult(result: GpxAnalysisResult): string {
  const lines: string[] = []

  lines.push('📍 GPX ANALYSIS RESULTS')
  lines.push('═'.repeat(50))

  // File summary
  lines.push(`\n📂 Analiz Edilen Dosyalar: ${result.files.length}`)
  for (const file of result.files) {
    const ptCount = file.tracks.reduce((s, t) => s + t.points.length, 0)
    lines.push(`  • ${file.metadata.name ?? file.filename}`)
    lines.push(`    Tarih: ${file.metadata.time ?? 'Bilinmiyor'} | Track: ${file.tracks.length} | Nokta: ${ptCount}`)
  }

  lines.push(`\n📊 Toplam: ${result.totalPoints} nokta, ${result.totalTracks} track`)

  // Center point
  lines.push(`\n🎯 GEOGRAPHIC CENTER: ${result.geographicCenter.lat}, ${result.geographicCenter.lon}`)

  if (result.centerGeocode) {
    lines.push(`📍 Adres: ${result.centerGeocode.displayName}`)
    lines.push(`🏙️ City: ${result.centerGeocode.city ?? 'Unknown'}`)
    lines.push(`🌍 Country: ${result.centerGeocode.country ?? 'Unknown'} (${result.centerGeocode.countryCode ?? '?'})`)
    if (result.centerGeocode.landmark) {
      lines.push(`🏛️ Landmark: ${result.centerGeocode.landmark}`)
    }
  }

  // Bounding box
  lines.push(`\n📐 Bounding Box:`)
  lines.push(`  Lat: ${result.boundingBox.minLat} → ${result.boundingBox.maxLat}`)
  lines.push(`  Lon: ${result.boundingBox.minLon} → ${result.boundingBox.maxLon}`)

  // Hotspots
  if (result.hotspots.length > 0) {
    lines.push(`\n🔥 TEKRAR EDEN KONUMLAR (Hotspots):`)
    for (let i = 0; i < result.hotspots.length; i++) {
      const hs = result.hotspots[i]
      lines.push(`\n  Hotspot #${i + 1}: ${hs.lat}, ${hs.lon}`)
      lines.push(`  Visit count: ${hs.visitCount} points (${hs.percentageOfTracks}% of tracks)`)
      if (hs.geocode) {
        lines.push(`  📍 ${hs.geocode.displayName}`)
        if (hs.geocode.city) lines.push(`  🏙️ City: ${hs.geocode.city}`)
        if (hs.geocode.landmark) lines.push(`  🏛️ Landmark: ${hs.geocode.landmark}`)
        if (hs.geocode.road) lines.push(`  🛣️ Yol: ${hs.geocode.road}`)
      }
    }
  }

  // Cross-track overlap analysis
  if (result.files.length > 1) {
    lines.push(`\n🔗 CROSS-FILE OVERLAP:`)
    const center = result.geographicCenter
    for (const file of result.files) {
      const allPts = file.tracks.flatMap(t => t.points)
      const nearCenter = allPts.filter(p => haversineDistanceKm(center, p) < 0.1)
      lines.push(`  • ${file.metadata.name ?? file.filename}: ${nearCenter.length}/${allPts.length} points near centre (<100m)`)
    }
  }

  if (result.errors.length > 0) {
    lines.push(`\n⚠️ Hatalar:`)
    for (const err of result.errors) {
      lines.push(`  • ${err}`)
    }
  }

  return lines.join('\n')
}
