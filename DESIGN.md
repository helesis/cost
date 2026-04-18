# Voyage Design System

Tüm sayfalarda `voyage-design-system.css` import edilecek.
Ek CSS yazılmayacak, mevcut class'lar kullanılacak.

## Import
```html
<link rel="stylesheet" href="voyage-design-system.css">
```

## Fontlar
- Başlıklar: `Playfair Display` (serif)
- Gövde: `Mulish` (sans-serif)
- Fontlar CSS içinde tanımlı, tekrar import etme.

## Renkler
| Token | Değer | Kullanım |
|---|---|---|
| `--gold` | #8a6c2e | Ana vurgu, butonlar |
| `--gold-light` | #c4a45a | Border, hover |
| `--gold-bg` | #f7f1e6 | Aktif arka plan |
| `--green` | #2d6a4f | Başarı, pozitif |
| `--red` | #7a2d2d | Hata, tehlike |
| `--yellow` | #92672a | Uyarı |
| `--blue` | #2a4d7a | Bilgi |
| `--text` | #1a1814 | Ana metin |
| `--text-dim` | #7a7369 | İkincil metin |
| `--bg` | #f5f3ef | Sayfa arka planı |
| `--surface` | #ffffff | Kart arka planı |

## Layout Class'ları
```
.page-header      — Sayfa üst başlık alanı
.page-title       — Playfair Display, 24px başlık
.page-sub         — Alt başlık / tarih
.page-body        — Sayfa içerik alanı (padding: 28px 32px)
#sidebar          — Sol sabit menü (240px)
#main             — Sidebar sağı, ana içerik
body.no-sidebar   — Sidebar olmayan sayfalar
```

## Bileşenler
```
.card             — Beyaz kart (border + shadow)
.card-title       — Kart başlığı (Playfair Display)
.stat-card        — İstatistik kartı (.green .yellow .red .gold .blue)
.stat-value       — Büyük sayı (Playfair Display, 32px)
.stat-label       — Küçük etiket (uppercase, 11px)
.stats-grid       — Stat kartları grid container
```

## Tablo
```
.table-wrap       — Overflow-x: auto wrapper
table             — Standart tablo stili
thead th          — Uppercase, 11px başlık
tbody td          — 12px 14px padding
```

## Butonlar
```
.btn              — Temel buton
.btn-primary      — Gold arka plan, beyaz yazı
.btn-secondary    — Gri arka plan
.btn-danger       — Kırmızı
.btn-ghost        — Şeffaf, border'lı
.btn-sm           — Küçük
.btn-lg           — Büyük
.btn-icon         — Sadece ikon
```

## Badge
```
.badge            — Temel badge
.badge-green      — Yeşil
.badge-yellow     — Sarı/turuncu
.badge-red        — Kırmızı
.badge-blue       — Mavi
.badge-gold       — Altın
.badge-gray       — Gri
```

## Form
```
.form-group       — Label + input wrapper
.form-label       — 12px, uppercase etiket
.form-input       — Metin girişi
.form-select      — Select kutusu
```

## Modal
```
.modal-overlay    — Karartma katmanı (.open ile göster)
.modal            — Modal kutu (480px)
.modal-header     — Başlık + kapat butonu
.modal-title      — Modal başlığı
.modal-body       — İçerik alanı
.modal-footer     — Buton alanı
.modal-close      — ✕ kapat butonu
```

## Tabs
```
.tabs             — Tab container
.tab-btn          — Tab butonu
.tab-btn.active   — Aktif tab (gold)
```

## Grid
```
.grid-2           — 2 kolon grid
.grid-3           — 3 kolon grid
.grid-4           — 4 kolon grid
```

## Durum
```
.loading          — Yükleniyor alanı
.spinner          — Dönen ikon
.toast            — Bildirim
.toast-success    — Başarı bildirimi
.toast-error      — Hata bildirimi
.toast-info       — Bilgi bildirimi
```

## Sidebar Bileşenleri
```
.sidebar-brand    — Logo alanı
.brand-mark       — Yuvarlak logo ikonu
.brand-name       — Sistem adı
.brand-sub        — Alt başlık
.sidebar-nav      — Menü listesi
.nav-item         — Menü öğesi
.nav-item.active  — Aktif menü öğesi
.nav-icon         — Menü ikonu
.sidebar-footer   — Alt kullanıcı alanı
.user-avatar      — Kullanıcı avatarı
.user-role        — Kullanıcı rolü
.btn-signout      — Çıkış butonu
```
