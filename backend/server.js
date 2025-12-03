// server.js
const express = require('express'); //framework for creating api endpoints
const sql = require('mssql'); //library for connecting to microsoft sql (azure)
const cors = require('cors'); //allows frontend (from a different port) call this API
//without cors browsers block requests from different origins

const app = express(); //create the web server
const port = 3000; //runs on port 3000

// database configuration
const dbConfig = {
    user: 'YOUR_USERNAME',
    password: 'YOUR_PASSWORD',
    server: 'YOUR_SERVER.database.windows.net',
    database: 'basketball_data',
    port: 1433,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true
    },
    connectionTimeout: 30000,
    requestTimeout: 30000
};

// this creates a reusable database connection
//instead of opening a new connection for every request, we open one connection and just reuse it
let globalPool = null;

//only create the connection if it doesn't exist yet
async function getPool() {
    if (!globalPool) {
        globalPool = await sql.connect(config); //connect to azure sql with the credentials
    }
    return globalPool;
}

app.use(cors()); //enable cors for all routees 

app.get('/', (req, res) => {
    res.send('API with Points, Rebounds & Assists predictions!');
});
//welcome message, test


//player endpoint for validation
//flow : front end guesses "Lebron", calls this endpoint /lebron, backend searches database for lebron, if found return true, player name

app.get('/api/player/:name', async (req, res) => {
    const playerName = req.params.name;
    
    try {
        const pool = await getPool();
        
        const result = await pool.request()
            .input('NameSearch', sql.VarChar, '%' + playerName + '%')
            .input('ExactStart', sql.VarChar, playerName + '%')
            .query(`
                SELECT TOP 1 PlayerName, TeamName, Season
                FROM Stats
                WHERE PlayerName LIKE @NameSearch AND Season = '2025-2026'
                ORDER BY 
                    CASE 
                        WHEN PlayerName LIKE @ExactStart THEN 1
                        WHEN LEN(PlayerName) - LEN(REPLACE(PlayerName, ' ', '')) = 1 THEN 2
                        ELSE 3
                    END,
                    LEN(PlayerName) ASC
            `);

            //the order by tries to find the most relevant match first 
            //priority 1: names that start with the search term (James = James Harden)
            //priority 2: simple full names (count the number of spaces in the name)
            //priority 3: everything else
        
        if (result.recordset.length > 0) {
            res.json({ found: true, player: result.recordset[0] });
        } else {
            res.json({ found: false, message: `No player found matching '${playerName}'` });
        }
    } catch (err) {
        console.error('SQL Error:', err.message);
        res.status(500).json({ message: 'Database query failed', error: err.message });
    }
});

//this endpoint gets detailed season staticstics for a player

app.get('/api/stats/:name', async (req, res) => {
    const playerName = req.params.name;
    
    try {
        const pool = await getPool();
        
        const result = await pool.request()
            .input('PlayerName', sql.VarChar, '%' + playerName + '%')
            .input('PlayerNameStart', sql.VarChar, playerName + '%')
            .query(`
                SELECT TOP 1
                    PlayerName,
                    COUNT(*) as GamesPlayed, 
                    ROUND(AVG(CAST(ISNULL(Points, 0) AS FLOAT)), 1) as AvgPoints,
                    ROUND(AVG(CAST(ISNULL(TotalRebounds, 0) AS FLOAT)), 1) as AvgRebounds,
                    ROUND(AVG(CAST(ISNULL(Assists, 0) AS FLOAT)), 1) as AvgAssists,
                    AVG(CAST(ISNULL(Steals, 0) AS FLOAT)) as AvgSteals,
                    AVG(CAST(ISNULL(Blocks, 0) AS FLOAT)) as AvgBlocks,
                    ROUND(AVG(CAST(ISNULL(ThreePointersMade, 0) AS FLOAT)), 1) as AvgThreePointers,
                    ROUND(AVG(CAST(ISNULL(Turnovers, 0) AS FLOAT)), 1) as AvgTurnovers,
                    MAX(ISNULL(Points, 0)) as MaxPoints,
                    MIN(ISNULL(Points, 0)) as MinPoints,
                    MAX(ISNULL(TotalRebounds, 0)) as MaxRebounds,
                    MIN(ISNULL(TotalRebounds, 0)) as MinRebounds,
                    MAX(ISNULL(Assists, 0)) as MaxAssists,
                    MIN(ISNULL(Assists, 0)) as MinAssists
                FROM [dbo].[Stats]
                WHERE PlayerName LIKE @PlayerName AND Season = '2025-2026'
                GROUP BY PlayerName
                ORDER BY 
                    CASE WHEN PlayerName LIKE @PlayerNameStart THEN 1 ELSE 2 END,
                    COUNT(*) DESC
            `);
        
        //built the json response 
        //takes the database results and organizes them into json strucutre
        if (result.recordset.length > 0) {
            const stats = result.recordset[0];
            
            res.json({
                found: true,
                playerName: stats.PlayerName,
                season: '2025-2026',
                gamesPlayed: stats.GamesPlayed,
                seasonAverages: {
                    points: Math.round(stats.AvgPoints * 10) / 10,
                    rebounds: Math.round(stats.AvgRebounds * 10) / 10,
                    assists: Math.round(stats.AvgAssists * 10) / 10,
                    steals: Math.round(stats.AvgSteals * 10) / 10,
                    blocks: Math.round(stats.AvgBlocks * 10) / 10,
                    threePointers: Math.round(stats.AvgThreePointers * 10) / 10
                },
                projection: {
                    points: Math.round(stats.AvgPoints * 10) / 10,
                    rebounds: Math.round(stats.AvgRebounds * 10) / 10,
                    assists: Math.round(stats.AvgAssists * 10) / 10,
                    steals: Math.round(stats.AvgSteals * 10) / 10,
                    blocks: Math.round(stats.AvgBlocks * 10) / 10,
                    threePointers: Math.round(stats.AvgThreePointers * 10) / 10,
                    turnovers: Math.round(stats.AvgTurnovers * 10) / 10
                },
                range: {
                    maxPoints: stats.MaxPoints,
                    minPoints: stats.MinPoints,
                    maxRebounds: stats.MaxRebounds,
                    minRebounds: stats.MinRebounds,
                    maxAssists: stats.MaxAssists,
                    minAssists: stats.MinAssists
                }
            });
        } else {
            res.json({
                found: false,
                message: `No stats found for player matching '${playerName}' in 2025-2026 season`
            });
        }
    } catch (err) {
        console.error('SQL Error:', err.message);
        res.status(500).json({ message: 'Database query failed', error: err.message });
    }
});

// endpoint for auto-detecting opponents 
app.get('/api/next-game/:player', async (req, res) => {
    const playerName = req.params.player;
    
    try {
        const pool = await getPool();
        
        // find players current team
        const playerTeamResult = await pool.request()
            .input('PlayerName', sql.VarChar, `%${playerName}%`)
            .query(`
                SELECT TOP 1 TeamId, TeamName
                FROM Stats
                WHERE PlayerName LIKE @PlayerName
                AND Season = '2025-2026'
                ORDER BY GameDate DESC
            `); 
            //find the most recent game first in case player was traded
            //returns team id and team name
        
        //if a player is not found, then return an error 
        if (playerTeamResult.recordset.length === 0) {
    
            return res.json({ 
                found: false, 
                message: `Player '${playerName}' not found` 
            });
        }

        //extract the team id and name from the results 
        
        const teamId = playerTeamResult.recordset[0].TeamId;
        const teamName = playerTeamResult.recordset[0].TeamName;
        
        // find next game
        //we are linking the schedule table to the teams table to get opponents full name
        const nextGameResult = await pool.request()
            .input('TeamId', sql.Int, teamId)
            .query(`
                SELECT TOP 1
                    s.GameDate,
                    s.HomeAway,
                    t.TeamName as OpponentTeam
                FROM Schedule s
                JOIN Teams t ON s.OpponentTeamId = t.Id
                WHERE s.TeamId = @TeamId
                AND s.GameDate > GETDATE()
                ORDER BY s.GameDate ASC
            `);
        
        //if no upcoming games, return error
        if (nextGameResult.recordset.length === 0) {
            return res.json({ 
                found: false, 
                message: `No upcoming games for ${teamName}` 
            });
        }
        
        //build and return the response with game info
        const nextGame = nextGameResult.recordset[0];
        
        res.json({
            found: true,
            player: playerName,
            team: teamName,
            nextGame: {
                date: nextGame.GameDate,
                opponent: nextGame.OpponentTeam,
                location: nextGame.HomeAway
            }
        });
        
    } catch (err) {
        console.error('Next Game Error:', err.message);
        console.error(err);
        res.status(500).json({ 
            found: false,
            error: 'Failed to find next game', 
            message: err.message 
        });
    }
});


//OLD PREDICTION LOGIC (uses weighted averages)
app.get('/api/predict/:player/:opponent', async (req, res) => {
    const playerName = req.params.player;
    const opponentTeam = req.params.opponent;
    
    try {
        const pool = await getPool();
        
        const seasonAvg = await pool.request().query(`
            SELECT TOP 1
                s.PlayerName,
                pa.AvgPoints, pa.AvgRebounds, pa.AvgAssists, pa.GamesPlayed,
                pa.Last5AvgPoints, pa.Last10AvgPoints
            FROM PlayerAggregates pa
            JOIN Stats s ON pa.PlayerApiId = s.PlayerApiId
            WHERE s.PlayerName LIKE '%${playerName}%'
            AND pa.Season = '2025-2026'
            AND s.Season = '2025-2026'
            ORDER BY 
                CASE 
                    WHEN s.PlayerName LIKE '${playerName}%' THEN 1
                    WHEN LEN(s.PlayerName) - LEN(REPLACE(s.PlayerName, ' ', '')) = 1 THEN 2
                    ELSE 3
                END,
                LEN(s.PlayerName) ASC
        `);
        
        if (seasonAvg.recordset.length === 0) {
            return res.json({ error: 'Player not found' });
        }
        
        const playerData = seasonAvg.recordset[0];
        const seasonPoints = playerData.AvgPoints;
        const seasonRebounds = playerData.AvgRebounds;
        const seasonAssists = playerData.AvgAssists;
        const last5Points = playerData.Last5AvgPoints || seasonPoints;
        const last10Points = playerData.Last10AvgPoints || seasonPoints;
        const gamesPlayed = playerData.GamesPlayed;
        
        // Get recent form for rebounds and assists
        const recentRebounds = await pool.request().query(`
            SELECT AVG(CAST(TotalRebounds AS FLOAT)) as Last5AvgRebounds
            FROM (
                SELECT TOP 5 TotalRebounds
                FROM Stats
                WHERE PlayerApiId = (SELECT TOP 1 PlayerApiId FROM Stats WHERE PlayerName LIKE '%${playerName}%')
                AND Season = '2025-2026' AND TotalRebounds IS NOT NULL
                ORDER BY GameDate DESC
            ) AS RecentGames
        `);
        
        const recentReboundsData = await pool.request().query(`
            SELECT AVG(CAST(TotalRebounds AS FLOAT)) as Last10AvgRebounds
            FROM (
                SELECT TOP 10 TotalRebounds
                FROM Stats
                WHERE PlayerApiId = (SELECT TOP 1 PlayerApiId FROM Stats WHERE PlayerName LIKE '%${playerName}%')
                AND Season = '2025-2026' AND TotalRebounds IS NOT NULL
                ORDER BY GameDate DESC
            ) AS RecentGames
        `);
        
        const recentAssists = await pool.request().query(`
            SELECT AVG(CAST(Assists AS FLOAT)) as Last5AvgAssists
            FROM (
                SELECT TOP 5 Assists
                FROM Stats
                WHERE PlayerApiId = (SELECT TOP 1 PlayerApiId FROM Stats WHERE PlayerName LIKE '%${playerName}%')
                AND Season = '2025-2026' AND Assists IS NOT NULL
                ORDER BY GameDate DESC
            ) AS RecentGames
        `);
        
        const recentAssistsData = await pool.request().query(`
            SELECT AVG(CAST(Assists AS FLOAT)) as Last10AvgAssists
            FROM (
                SELECT TOP 10 Assists
                FROM Stats
                WHERE PlayerApiId = (SELECT TOP 1 PlayerApiId FROM Stats WHERE PlayerName LIKE '%${playerName}%')
                AND Season = '2025-2026' AND Assists IS NOT NULL
                ORDER BY GameDate DESC
            ) AS RecentGames
        `);
        
        const last5Rebounds = recentRebounds.recordset.length > 0 ? 
            recentRebounds.recordset[0].Last5AvgRebounds : seasonRebounds;
        const last10Rebounds = recentReboundsData.recordset.length > 0 ? 
            recentReboundsData.recordset[0].Last10AvgRebounds : seasonRebounds;
        const last5Assists = recentAssists.recordset.length > 0 ? 
            recentAssists.recordset[0].Last5AvgAssists : seasonAssists;
        const last10Assists = recentAssistsData.recordset.length > 0 ? 
            recentAssistsData.recordset[0].Last10AvgAssists : seasonAssists;
        
        // Get opponent defense
        const opponentDefense = await pool.request().query(`
            SELECT AvgPointsAllowed
            FROM OpponentDefensiveStats
            WHERE TeamId = (SELECT Id FROM Teams WHERE TeamName LIKE '%${opponentTeam}%')
            AND Season = '2025-2026'
        `);
        
        let opponentPointsAllowed = 110;
        if (opponentDefense.recordset.length > 0) {
            opponentPointsAllowed = opponentDefense.recordset[0].AvgPointsAllowed;
        }
        
        // Get matchup history (points, rebounds, assists)
        const matchupHistory = await pool.request().query(`
            SELECT AvgPoints, AvgRebounds, AvgAssists, GamesPlayed
            FROM PlayerVsTeam
            WHERE PlayerApiId = (SELECT TOP 1 PlayerApiId FROM Stats WHERE PlayerName LIKE '%${playerName}%')
            AND OpponentTeamId = (SELECT Id FROM Teams WHERE TeamName LIKE '%${opponentTeam}%')
            AND Season IN ('2023-2024', '2025-2026')
        `);
        
        let vsTeamPoints = null;
        let vsTeamRebounds = null;
        let vsTeamAssists = null;
        let vsTeamGames = 0;
        if (matchupHistory.recordset.length > 0) {
            vsTeamPoints = matchupHistory.recordset[0].AvgPoints;
            vsTeamRebounds = matchupHistory.recordset[0].AvgRebounds;
            vsTeamAssists = matchupHistory.recordset[0].AvgAssists;
            vsTeamGames = matchupHistory.recordset[0].GamesPlayed;
        }
        
        // ===== POINTS PREDICTION =====
        let pointsPrediction = 0;
        if (vsTeamPoints !== null && vsTeamGames >= 2) {
            pointsPrediction = (vsTeamPoints * 0.5) + (last5Points * 0.3) + (seasonPoints * 0.2);
        } else {
            pointsPrediction = (seasonPoints * 0.3) + (last10Points * 0.3) + (last5Points * 0.4);
        }
        
        if (opponentPointsAllowed > 110) {
            pointsPrediction *= 1.05;
        } else if (opponentPointsAllowed < 110) {
            pointsPrediction *= 0.95;
        }
        pointsPrediction = Math.round(pointsPrediction * 10) / 10;
        
        // ===== REBOUNDS PREDICTION =====
        let reboundsPrediction = 0;
        if (vsTeamRebounds !== null && vsTeamGames >= 2) {
            reboundsPrediction = (vsTeamRebounds * 0.5) + (last5Rebounds * 0.3) + (seasonRebounds * 0.2);
        } else {
            reboundsPrediction = (seasonRebounds * 0.3) + (last10Rebounds * 0.3) + (last5Rebounds * 0.4);
        }
        
        if (opponentPointsAllowed > 110) {
            reboundsPrediction *= 0.95;
        } else if (opponentPointsAllowed < 110) {
            reboundsPrediction *= 1.05;
        }
        reboundsPrediction = Math.round(reboundsPrediction * 10) / 10;
        
        // ===== ASSISTS PREDICTION =====
        let assistsPrediction = 0;
        if (vsTeamAssists !== null && vsTeamGames >= 2) {
            assistsPrediction = (vsTeamAssists * 0.5) + (last5Assists * 0.3) + (seasonAssists * 0.2);
        } else {
            assistsPrediction = (seasonAssists * 0.3) + (last10Assists * 0.3) + (last5Assists * 0.4);
        }
        
        // Assists slightly affected by pace (similar to points but less)
        if (opponentPointsAllowed > 110) {
            assistsPrediction *= 1.02; // Fast pace = more assists
        } else if (opponentPointsAllowed < 110) {
            assistsPrediction *= 0.98; // Slow pace = fewer assists
        }
        assistsPrediction = Math.round(assistsPrediction * 10) / 10;
        
        // ===== CONFIDENCE CALCULATIONS =====
        
        // Points confidence
        let pointsConfidence = 30;
        const pointsConsistency = Math.abs(last5Points - seasonPoints);
        if (pointsConsistency < 2) pointsConfidence += 20;
        else if (pointsConsistency < 4) pointsConfidence += 12;
        else if (pointsConsistency < 6) pointsConfidence += 6;
        else if (pointsConsistency < 10) pointsConfidence += 2;
        
        if (gamesPlayed >= 30) pointsConfidence += 20;
        else if (gamesPlayed >= 20) pointsConfidence += 14;
        else if (gamesPlayed >= 15) pointsConfidence += 8;
        else if (gamesPlayed >= 10) pointsConfidence += 4;
        else if (gamesPlayed >= 5) pointsConfidence += 2;
        
        if (vsTeamGames >= 5) pointsConfidence += 15;
        else if (vsTeamGames >= 3) pointsConfidence += 9;
        else if (vsTeamGames >= 1) pointsConfidence += 4;
        
        if (last5Points && seasonPoints) {
            const recencyDiff = Math.abs(last5Points - seasonPoints);
            if (recencyDiff < 3) pointsConfidence += 10;
            else if (recencyDiff < 5) pointsConfidence += 5;
        }
        
        const pointsPredictionDiff = Math.abs(pointsPrediction - seasonPoints);
        if (pointsPredictionDiff > 10) pointsConfidence -= 10;
        else if (pointsPredictionDiff > 5) pointsConfidence -= 5;
        
        pointsConfidence = Math.max(20, Math.min(85, pointsConfidence));
        
        // Rebounds confidence
        let reboundsConfidence = 30;
        const reboundsConsistency = Math.abs(last5Rebounds - seasonRebounds);
        if (reboundsConsistency < 1) reboundsConfidence += 20;
        else if (reboundsConsistency < 2) reboundsConfidence += 12;
        else if (reboundsConsistency < 3) reboundsConfidence += 6;
        else if (reboundsConsistency < 5) reboundsConfidence += 2;
        
        if (gamesPlayed >= 30) reboundsConfidence += 20;
        else if (gamesPlayed >= 20) reboundsConfidence += 14;
        else if (gamesPlayed >= 15) reboundsConfidence += 8;
        else if (gamesPlayed >= 10) reboundsConfidence += 4;
        else if (gamesPlayed >= 5) reboundsConfidence += 2;
        
        if (vsTeamGames >= 5) reboundsConfidence += 15;
        else if (vsTeamGames >= 3) reboundsConfidence += 9;
        else if (vsTeamGames >= 1) reboundsConfidence += 4;
        
        if (last5Rebounds && seasonRebounds) {
            const recencyDiff = Math.abs(last5Rebounds - seasonRebounds);
            if (recencyDiff < 1.5) reboundsConfidence += 10;
            else if (recencyDiff < 2.5) reboundsConfidence += 5;
        }
        
        const reboundsPredictionDiff = Math.abs(reboundsPrediction - seasonRebounds);
        if (reboundsPredictionDiff > 5) reboundsConfidence -= 10;
        else if (reboundsPredictionDiff > 2.5) reboundsConfidence -= 5;
        
        reboundsConfidence = Math.max(20, Math.min(85, reboundsConfidence));
        
        // Assists confidence
        let assistsConfidence = 30;
        const assistsConsistency = Math.abs(last5Assists - seasonAssists);
        if (assistsConsistency < 1) assistsConfidence += 20;
        else if (assistsConsistency < 2) assistsConfidence += 12;
        else if (assistsConsistency < 3) assistsConfidence += 6;
        else if (assistsConsistency < 5) assistsConfidence += 2;
        
        if (gamesPlayed >= 30) assistsConfidence += 20;
        else if (gamesPlayed >= 20) assistsConfidence += 14;
        else if (gamesPlayed >= 15) assistsConfidence += 8;
        else if (gamesPlayed >= 10) assistsConfidence += 4;
        else if (gamesPlayed >= 5) assistsConfidence += 2;
        
        if (vsTeamGames >= 5) assistsConfidence += 15;
        else if (vsTeamGames >= 3) assistsConfidence += 9;
        else if (vsTeamGames >= 1) assistsConfidence += 4;
        
        if (last5Assists && seasonAssists) {
            const recencyDiff = Math.abs(last5Assists - seasonAssists);
            if (recencyDiff < 1.5) assistsConfidence += 10;
            else if (recencyDiff < 2.5) assistsConfidence += 5;
        }
        
        const assistsPredictionDiff = Math.abs(assistsPrediction - seasonAssists);
        if (assistsPredictionDiff > 5) assistsConfidence -= 10;
        else if (assistsPredictionDiff > 2.5) assistsConfidence -= 5;
        
        assistsConfidence = Math.max(20, Math.min(85, assistsConfidence));
        
        res.json({
            player: playerName,
            opponent: opponentTeam,
            predictions: {
                points: { value: pointsPrediction, confidence: pointsConfidence },
                rebounds: { value: reboundsPrediction, confidence: reboundsConfidence },
                assists: { value: assistsPrediction, confidence: assistsConfidence }
            },
            breakdown: {
                seasonAvgPoints: seasonPoints,
                seasonAvgRebounds: seasonRebounds,
                seasonAvgAssists: seasonAssists,
                last5AvgPoints: last5Points,
                last5AvgRebounds: last5Rebounds,
                last5AvgAssists: last5Assists,
                vsTeamPoints: vsTeamPoints,
                vsTeamRebounds: vsTeamRebounds,
                vsTeamAssists: vsTeamAssists,
                opponentDefense: opponentPointsAllowed
            }
        });
        
    } catch (err) {
        console.error('Prediction Error:', err.message);
        res.status(500).json({ error: 'Prediction failed', message: err.message });
    }
});

// comparison endpoint
app.get('/api/compare/:player1/:player2/:opponent', async (req, res) => {
    const player1Name = req.params.player1;
    const player2Name = req.params.player2;
    let opponentTeam = req.params.opponent; 

    //get both player names and opponent from the URL
    
    try {
        const pool = await getPool();

        const axios = require('axios'); //library for making http requests

        const PREDICT_URL = 'http://localhost:5001/api/ml/predict';
        const NEXT_GAME_URL = 'http://localhost:3000/api/next-game';
        
        // auto-detect both players' next games
        //promise.all makes them run at the same time instead of waiting for the first one to find
        const [player1NextGame, player2NextGame] = await Promise.all([
            axios.get(`${NEXT_GAME_URL}/${encodeURIComponent(player1Name)}`).catch(e => ({ data: { found: false } })),
            axios.get(`${NEXT_GAME_URL}/${encodeURIComponent(player2Name)}`).catch(e => ({ data: { found: false } }))
        ]);
        
        // get opponents for each player
        const player1Opponent = player1NextGame.data.found ? 
            player1NextGame.data.nextGame.opponent : opponentTeam;
        const player2Opponent = player2NextGame.data.found ? 
            player2NextGame.data.nextGame.opponent : opponentTeam;
        
        // Get ML predictions for each player vs their own opponent (calling the python server)
        const [player1Response, player2Response] = await Promise.all([
            axios.get(`${PREDICT_URL}/${encodeURIComponent(player1Name)}/${encodeURIComponent(player1Opponent)}`),
            axios.get(`${PREDICT_URL}/${encodeURIComponent(player2Name)}/${encodeURIComponent(player2Opponent)}`)
        ]);

        //extract data from the responses
        
        const player1Data = player1Response.data;
        const player2Data = player2Response.data;

        //if failed, return error
        
        if (player1Data.error || player2Data.error) {
            return res.json({
                error: 'One or both players not found',
                player1Error: player1Data.error,
                player2Error: player2Data.error
            });
        }
        
        // get recent form
        const getRecentForm = async (playerName) => {
            const result = await pool.request().query(`
                SELECT TOP 1
                    pa.Last5AvgPoints,
                    pa.AvgPoints as SeasonAvgPoints
                FROM PlayerAggregates pa
                JOIN Stats s ON pa.PlayerApiId = s.PlayerApiId
                WHERE s.PlayerName LIKE '%${playerName}%'
                AND pa.Season = '2025-2026'
            `);
            
            if (result.recordset.length > 0) {
                const data = result.recordset[0];
                const last5 = data.Last5AvgPoints;
                const season = data.SeasonAvgPoints;
                
                if (last5 > season + 2) return 'HOT '; //if last 5 games > season avg + 2 : player is considered hot
                if (last5 < season - 2) return 'COLD '; // if last 5 games < season abvg - 2: player is considered cold
                return 'STEADY'; // otherwise, steady
            }
            return 'STEADY';
        };

        //get recent form for both players
        
        const player1Form = await getRecentForm(player1Name);
        const player2Form = await getRecentForm(player2Name);
        
         
        // build response with ML predictions

        //get fantasy scores 
        const p1Fantasy = player1Data.predictions.fantasyScore.value;
        const p2Fantasy = player2Data.predictions.fantasyScore.value;
        
        const fantasyDiff = Math.abs(p1Fantasy - p2Fantasy); //calculate the difference between them
        
        //intialize recommendation variables
        let recommendation = '';
        let recommendationConfidence = 'Medium';
        
        //set confidence level based on the difference
        if (fantasyDiff < 2) {
            recommendationConfidence = 'Low';
            recommendation = `Too close to call!`;
        } else if (fantasyDiff > 5) {
            recommendationConfidence = 'High';
        }
        
        //make the recommendation based on fantasy scores
        if (p1Fantasy > p2Fantasy && fantasyDiff >= 2) {
            recommendation = `✅ Start ${player1Data.player}`;
        } else if (p2Fantasy > p1Fantasy && fantasyDiff >= 2) {
            recommendation = `✅ Start ${player2Data.player}`;
        }
        
        // build reasons
        const reasons = [];

        //if point difference >5 add that as a reason
        const pointsDiff = Math.abs(player1Data.predictions.points.value - player2Data.predictions.points.value);
        
        if (pointsDiff > 5) {
            const leader = player1Data.predictions.points.value > player2Data.predictions.points.value ? 
                player1Data.player : player2Data.player;
            reasons.push(`${leader} projected for +${pointsDiff.toFixed(1)} more points`);
        }

        //add hot/cold streak reasons
        
        if (player1Form === 'HOT ') reasons.push(`${player1Data.player} is hot (last 5 games)`);
        if (player2Form === 'HOT ') reasons.push(`${player2Data.player} is hot (last 5 games)`);
        if (player1Form === 'COLD ') reasons.push(`${player1Data.player} has been cold`);
        if (player2Form === 'COLD ') reasons.push(`${player2Data.player} has been cold`);
        
        // check matchup advantages
        //add matchup advantage reasons if they perform 3+ points better vs opponent historically
        if (player1Data.breakdown.vsTeamPoints && 
            player1Data.breakdown.vsTeamPoints > player1Data.breakdown.seasonAvgPoints + 3) {
            reasons.push(`${player1Data.player} performs well vs ${player1Opponent}`);
        }
        if (player2Data.breakdown.vsTeamPoints && 
            player2Data.breakdown.vsTeamPoints > player2Data.breakdown.seasonAvgPoints + 3) {
            reasons.push(`${player2Data.player} performs well vs ${player2Opponent}`);
        }

        //final response

        //packages everything into one big json response 
        //this gets sent to the front end to display
        res.json({
            player1: {
                name: player1Data.player,
                opponent: player1Opponent,
                gameInfo: player1NextGame.data.found ? {
                    date: player1NextGame.data.nextGame.date,
                    location: player1NextGame.data.nextGame.location
                } : null,
                predictions: {
                    points: player1Data.predictions.points.value,
                    rebounds: player1Data.predictions.rebounds.value,
                    assists: player1Data.predictions.assists.value,
                    steals: player1Data.predictions.steals.value,
                    blocks: player1Data.predictions.blocks.value,
                    turnovers: player1Data.predictions.turnovers.value
                },
                recentForm: { trend: player1Form },
                projectedFantasyPoints: p1Fantasy
            },
            player2: {
                name: player2Data.player,
                opponent: player2Opponent,
                gameInfo: player2NextGame.data.found ? {
                    date: player2NextGame.data.nextGame.date,
                    location: player2NextGame.data.nextGame.location
                } : null,
                predictions: {
                    points: player2Data.predictions.points.value,
                    rebounds: player2Data.predictions.rebounds.value,
                    assists: player2Data.predictions.assists.value,
                    steals: player2Data.predictions.steals.value,
                    blocks: player2Data.predictions.blocks.value,
                    turnovers: player2Data.predictions.turnovers.value
                },
                recentForm: { trend: player2Form },
                projectedFantasyPoints: p2Fantasy
            },
            recommendation: recommendation,
            confidence: recommendationConfidence,
            reasons: reasons
        });
        
    } catch (err) {
        console.error('Comparison Error:', err.message);
        res.status(500).json({ error: 'Comparison failed', message: err.message });
    }
});

const server = app.listen(port, () => {
    console.log(`✓ Server running at http://localhost:${port}`);
});

server.on('error', (err) => console.error('Server error:', err));

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});

//signal to tell program to stop
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});