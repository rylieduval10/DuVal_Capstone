# NBA Fantasy Sports Projector

ML-powered NBA player performance prediction system using Random Forest models trained on 185K+ box scores.

## Overview

Predicts 6 key stats for NBA players:
- Points, Rebounds, Assists
- Steals, Blocks, Turnovers
- Fantasy Score calculation

Features:
-ML-Powered Predictions 
- Auto-detects next games
- Historical matchup analysis
- Player comparisons
- Natural language queries

## Tech Stack

**Frontend:** JavaScript, HTML, CSS
**Backend:** Node.js/Express
**ML Service:** Python/Flask with scikit-learn
**Database:** Azure SQL Server
**APIs:** Basketball API, NBA API

Start Services

Terminal 1 - Node.js API:
```bash
node server.js
```

Terminal 2 - Python ML Service:
```bash
python3 predict_service.py
```

Open Application

Open `index.html` in browser 
```

## Example Queries

- "LeBron James"
- "Stephen Curry points vs Lakers"
- "Compare Giannis and Embiid"
- "Kevin Durant steals"

## Model Performance

**Training Data:** 185,422 games (2022-2026)

**Accuracy:**
- Points: 4.40 MAE, 58.9% R²
- Rebounds: 1.82 MAE, 51.9% R²
- Assists: 1.28 MAE, 57.5% R²
- Steals: 0.62 MAE, 22.9% R²
- Blocks: 0.53 MAE, 35.2% R²
- Turnovers: 0.80 MAE, 36.5% R²


## API Endpoints

**Node.js (port 3000):**
- `GET /api/player/:name` - Find player
- `GET /api/next-game/:player` - Get next game
- `GET /api/compare/:player1/:player2/:opponent` - Compare players

**Python (port 5001):**
- `POST /api/ml/predict/:player/:opponent` - Generate prediction

## Features

- 6-stat predictions with confidence scores
- Auto-detects player's next opponent
- Multi-season matchup history (2022-present)
- Recent form analysis (last 5/10 games)
- Opponent defensive ratings
- Fantasy score calculation
- Player comparison tool
- Natural language query parser

## Author

Rylie DuVal - Senior Computer Science Student
