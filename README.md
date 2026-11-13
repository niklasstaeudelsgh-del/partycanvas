# Digitale Leinwand für Feiern

QR-Code scannen, Foto machen (normal oder mit Party-Aufgabe), alle Fotos auf einer gemeinsamen Leinwand ansehen.

## Einrichtung (ca. 15 Minuten, alles kostenlos)

### 1. Datenbank: Neon
1. Konto auf https://neon.tech anlegen, neues Projekt erstellen.
2. Die **Connection string** kopieren (beginnt mit `postgresql://`). Das ist dein `DATABASE_URL`.

### 2. Fotospeicher: Cloudinary
1. Konto auf https://cloudinary.com anlegen.
2. Dashboard > **API Keys** > "API Environment variable" kopieren (`cloudinary://...`). Das ist dein `CLOUDINARY_URL`.

### 3. Code auf GitHub
1. Neues Repository auf github.com anlegen (z. B. `feier-leinwand`).
2. Diesen Ordner hochladen:
   ```
   git init
   git add .
   git commit -m "Erste Version"
   git branch -M main
   git remote add origin https://github.com/DEIN-NAME/feier-leinwand.git
   git push -u origin main
   ```

### 4. Render
1. https://render.com > **New +** > **Web Service** > GitHub-Repository auswählen.
2. Build Command: `npm install`, Start Command: `npm start`, Plan: Free.
3. Unter **Environment** zwei Variablen eintragen: `DATABASE_URL` und `CLOUDINARY_URL`.
4. Deploy. Fertig: Deine Seite läuft unter `https://....onrender.com`.

(Alternativ: **New +** > **Blueprint**, dann liest Render die `render.yaml`.)

## Hinweise
- Der kostenlose Render-Plan schläft nach 15 Minuten ohne Besuch ein. Der erste Aufruf dauert dann ca. 30 bis 60 Sekunden. Tipp: Eine Stunde vor der Feier die Seite einmal öffnen, oder einen kostenlosen Ping-Dienst (z. B. UptimeRobot auf `/health`) einrichten.
- Der QR-Code zeigt auf die Adresse, unter der du die Seite öffnest. Ändert sich die Domain, den QR-Code neu drucken. Mit der Variable `BASE_URL` kannst du eine feste Adresse vorgeben.
- Der **Verwaltungs-Link** (`/admin/...#schlüssel`) ist der Schlüssel zum Löschen von Fotos. Er wird auf dem Gerät des Erstellers gespeichert und steht auf der Startseite unter "Meine Feiern".

## Lokal testen
```
npm install
# .env.example nach .env kopieren, Werte eintragen, dann:
node --env-file=.env server.js
```

## Aufgaben ändern
Die 35 Party-Aufgaben stehen in `public/js/tasks.js`.
