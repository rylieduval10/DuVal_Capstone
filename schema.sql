-- Fantasy Sports Projector - Database Schema

-- This schema creates all tables needed for the NBA Fantasy Sports
-- prediction system, including player stats, game schedules, and
-- machine learning prediction tracking.

-- Tables:
--   - Teams: NBA team information
--   - Players: NBA player information
--   - Games: Game schedules and results
--   - Stats: Individual player game statistics
--   - PlayerAggregates: Pre-calculated season averages
--   - PlayerVsTeam: Matchup-specific historical stats
--   - OpponentDefensiveStats: Team defensive metrics
--   - TeamGameStats: Team-level game statistics
--   - Schedule: Upcoming game schedules
--   - MLPredictions: Machine learning prediction tracking

-- CORE TABLES


-- Teams Table
-- Stores all NBA teams with their API Sports ID mapping
CREATE TABLE [dbo].[Teams] (
    [Id]          INT           IDENTITY (1, 1) NOT NULL,
    [APISportsId] INT           NOT NULL,
    [TeamName]    VARCHAR (100) NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);

-- Players Table
-- Stores NBA player information from API Sports
CREATE TABLE [dbo].[Players] (
    [Id]          INT           IDENTITY (1, 1) NOT NULL,
    [APISportsId] INT           NOT NULL,
    [Name]        VARCHAR (100) NOT NULL,
    [Number]      VARCHAR (10)  NULL,
    [Country]     VARCHAR (50)  NULL,
    [Position]    VARCHAR (50)  NULL,
    [Age]         INT           NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);

-- Games Table
-- Stores all NBA games with scores and status
CREATE TABLE [dbo].[Games] (
    [Id]          INT           IDENTITY (1, 1) NOT NULL,
    [APISportsId] INT           NOT NULL,
    [HomeTeam]    VARCHAR (100) NOT NULL,
    [AwayTeam]    VARCHAR (100) NOT NULL,
    [Status]      VARCHAR (10)  NOT NULL,  -- e.g., 'FT' (Finished), 'SCH' (Scheduled)
    [StartTime]   DATETIME      NOT NULL,
    [ScoreHome]   INT           DEFAULT ((0)) NULL,
    [ScoreAway]   INT           DEFAULT ((0)) NULL,
    [Venue]       VARCHAR (255) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);

-- STATISTICS TABLES

-- Stats Table
-- Individual player box scores for each game
-- This is the core data table - all aggregates are derived from this
CREATE TABLE [dbo].[Stats] (
    [Id]                     INT            IDENTITY (1, 1) NOT NULL,
    [PlayerApiId]            INT            NOT NULL,
    [PlayerName]             NVARCHAR (100) NOT NULL,
    [GameId]                 INT            NOT NULL,
    [GameDate]               NVARCHAR (50)  NULL,
    [Season]                 NVARCHAR (20)  NOT NULL,  -- e.g., '2024-2025'
    [TeamId]                 INT            NOT NULL,
    [TeamName]               NVARCHAR (100) NULL,
    [MinutesPlayed]          NVARCHAR (10)  NULL,      -- e.g., '32:45'
    [Points]                 INT            DEFAULT ((0)) NULL,
    [FieldGoalsMade]         INT            DEFAULT ((0)) NULL,
    [FieldGoalsAttempted]    INT            DEFAULT ((0)) NULL,
    [FieldGoalPercentage]    FLOAT (53)     DEFAULT ((0.0)) NULL,
    [ThreePointersMade]      INT            DEFAULT ((0)) NULL,
    [ThreePointersAttempted] INT            DEFAULT ((0)) NULL,
    [ThreePointPercentage]   FLOAT (53)     DEFAULT ((0.0)) NULL,
    [FreeThrowsMade]         INT            DEFAULT ((0)) NULL,
    [FreeThrowsAttempted]    INT            DEFAULT ((0)) NULL,
    [FreeThrowPercentage]    FLOAT (53)     DEFAULT ((0.0)) NULL,
    [OffensiveRebounds]      INT            DEFAULT ((0)) NULL,
    [DefensiveRebounds]      INT            DEFAULT ((0)) NULL,
    [TotalRebounds]          INT            DEFAULT ((0)) NULL,
    [Assists]                INT            DEFAULT ((0)) NULL,
    [Steals]                 INT            DEFAULT ((0)) NULL,
    [Blocks]                 INT            DEFAULT ((0)) NULL,
    [Turnovers]              INT            DEFAULT ((0)) NULL,
    [PersonalFouls]          INT            DEFAULT ((0)) NULL,
    [PlusMinus]              INT            DEFAULT ((0)) NULL,
    [CreatedDate]            DATETIME2 (7)  DEFAULT (getdate()) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);

-- Indexes for Stats table - critical for query performance
CREATE NONCLUSTERED INDEX [IX_Stats_PlayerApiId]
    ON [dbo].[Stats]([PlayerApiId] ASC);

CREATE NONCLUSTERED INDEX [IX_Stats_Season]
    ON [dbo].[Stats]([Season] ASC);

CREATE NONCLUSTERED INDEX [IX_Stats_PlayerApiId_Season]
    ON [dbo].[Stats]([PlayerApiId] ASC, [Season] ASC);

CREATE NONCLUSTERED INDEX [IX_Stats_TeamId]
    ON [dbo].[Stats]([TeamId] ASC);

CREATE NONCLUSTERED INDEX [IX_Stats_GameId]
    ON [dbo].[Stats]([GameId] ASC);

-- TeamGameStats Table
-- Aggregated team-level statistics per game
CREATE TABLE [dbo].[TeamGameStats] (
    [Id]                   INT           IDENTITY (1, 1) NOT NULL,
    [GameId]               INT           NOT NULL,
    [TeamId]               INT           NOT NULL,
    [Season]               NVARCHAR (20) NOT NULL,
    [GameDate]             NVARCHAR (50) NULL,
    [IsHome]               BIT           NOT NULL,
    [Points]               INT           DEFAULT ((0)) NULL,
    [FieldGoalPercentage]  FLOAT (53)    DEFAULT ((0.0)) NULL,
    [ThreePointPercentage] FLOAT (53)    DEFAULT ((0.0)) NULL,
    [Rebounds]             INT           DEFAULT ((0)) NULL,
    [Assists]              INT           DEFAULT ((0)) NULL,
    [Turnovers]            INT           DEFAULT ((0)) NULL,
    [Steals]               INT           DEFAULT ((0)) NULL,
    [Blocks]               INT           DEFAULT ((0)) NULL,
    [OpponentPoints]       INT           DEFAULT ((0)) NULL,
    [Possessions]          INT           NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);

CREATE NONCLUSTERED INDEX [IX_TeamGameStats_TeamId_Season]
    ON [dbo].[TeamGameStats]([TeamId] ASC, [Season] ASC);

CREATE NONCLUSTERED INDEX [IX_TeamGameStats_GameId]
    ON [dbo].[TeamGameStats]([GameId] ASC);

-- AGGREGATE TABLES (Pre-calculated for ML Model Performance)

-- PlayerAggregates Table
-- Pre-calculated season statistics for each player
-- Updated by configure.js script after new stats are loaded
CREATE TABLE [dbo].[PlayerAggregates] (
    [Id]               INT           IDENTITY (1, 1) NOT NULL,
    [PlayerApiId]      INT           NOT NULL,
    [Season]           NVARCHAR (20) NOT NULL,
    [LastUpdated]      DATETIME2 (7) DEFAULT (getdate()) NULL,
    [GamesPlayed]      INT           DEFAULT ((0)) NULL,
    [AvgPoints]        FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgRebounds]      FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgAssists]       FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgMinutes]       FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgFieldGoalPct]  FLOAT (53)    DEFAULT ((0.0)) NULL,
    [Last5AvgPoints]   FLOAT (53)    DEFAULT ((0.0)) NULL,
    [Last5AvgMinutes]  FLOAT (53)    DEFAULT ((0.0)) NULL,
    [Last10AvgPoints]  FLOAT (53)    DEFAULT ((0.0)) NULL,
    [Last10AvgMinutes] FLOAT (53)    DEFAULT ((0.0)) NULL,
    [HomeAvgPoints]    FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AwayAvgPoints]    FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgSteals]        FLOAT (53)    NULL,
    [AvgBlocks]        FLOAT (53)    NULL,
    [AvgTurnovers]     FLOAT (53)    NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UQ_PlayerAggregates] UNIQUE NONCLUSTERED ([PlayerApiId] ASC, [Season] ASC)
);

-- PlayerVsTeam Table
-- Matchup-specific historical statistics
-- Used as ML model feature for predicting performance vs specific opponents
CREATE TABLE [dbo].[PlayerVsTeam] (
    [Id]             INT           IDENTITY (1, 1) NOT NULL,
    [PlayerApiId]    INT           NOT NULL,
    [OpponentTeamId] INT           NOT NULL,
    [Season]         NVARCHAR (20) NOT NULL,
    [GamesPlayed]    INT           DEFAULT ((0)) NULL,
    [AvgPoints]      FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgMinutes]     FLOAT (53)    DEFAULT ((0.0)) NULL,
    [LastUpdated]    DATETIME2 (7) DEFAULT (getdate()) NULL,
    [AvgRebounds]    FLOAT (53)    NULL,
    [AvgAssists]     FLOAT (53)    NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UQ_PlayerVsTeam] UNIQUE NONCLUSTERED ([PlayerApiId] ASC, [OpponentTeamId] ASC, [Season] ASC)
);

-- OpponentDefensiveStats Table
-- Team defensive metrics used as ML model features
CREATE TABLE [dbo].[OpponentDefensiveStats] (
    [Id]                      INT           IDENTITY (1, 1) NOT NULL,
    [TeamId]                  INT           NOT NULL,
    [Season]                  NVARCHAR (20) NOT NULL,
    [GamesPlayed]             INT           DEFAULT ((0)) NULL,
    [AvgPointsAllowed]        FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgFieldGoalPctAllowed]  FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgThreePointPctAllowed] FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgReboundsAllowed]      FLOAT (53)    DEFAULT ((0.0)) NULL,
    [AvgAssistsAllowed]       FLOAT (53)    DEFAULT ((0.0)) NULL,
    [LastUpdated]             DATETIME2 (7) DEFAULT (getdate()) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UQ_OpponentDefensiveStats] UNIQUE NONCLUSTERED ([TeamId] ASC, [Season] ASC)
);

-- SCHEDULE AND PREDICTION TRACKING

-- Schedule Table
-- Upcoming game schedules for auto-detecting next opponent
CREATE TABLE [dbo].[Schedule] (
    [Id]             INT          IDENTITY (1, 1) NOT NULL,
    [TeamId]         INT          NOT NULL,
    [OpponentTeamId] INT          NOT NULL,
    [GameDate]       DATETIME     NOT NULL,
    [Season]         VARCHAR (10) NOT NULL,
    [HomeAway]       VARCHAR (4)  NULL,  -- 'Home' or 'Away'
    [CreatedDate]    DATETIME     DEFAULT (getdate()) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    FOREIGN KEY ([TeamId]) REFERENCES [dbo].[Teams] ([Id]),
    FOREIGN KEY ([OpponentTeamId]) REFERENCES [dbo].[Teams] ([Id])
);

CREATE NONCLUSTERED INDEX [IX_Schedule_TeamDate]
    ON [dbo].[Schedule]([TeamId] ASC, [GameDate] ASC);

CREATE NONCLUSTERED INDEX [IX_Schedule_Season]
    ON [dbo].[Schedule]([Season] ASC);

-- MLPredictions Table
-- Tracks all ML predictions for accuracy evaluation
-- Stores predicted vs actual results after games complete
CREATE TABLE [dbo].[MLPredictions] (
    [Id]                INT            IDENTITY (1, 1) NOT NULL,
    [PlayerName]        NVARCHAR (100) NOT NULL,
    [OpponentTeam]      NVARCHAR (100) NOT NULL,
    [GameDate]          DATETIME       NULL,
    [PredictedPoints]   FLOAT (53)     NOT NULL,
    [PredictedRebounds] FLOAT (53)     NOT NULL,
    [PredictedAssists]  FLOAT (53)     NOT NULL,
    [ActualPoints]      INT            NULL,
    [ActualRebounds]    INT            NULL,
    [ActualAssists]     INT            NULL,
    [PointsError]       FLOAT (53)     NULL,  
    [ReboundsError]     FLOAT (53)     NULL,
    [AssistsError]      FLOAT (53)     NULL,
    [CreatedDate]       DATETIME       DEFAULT (getdate()) NULL,
    [GameCompleted]     BIT            DEFAULT ((0)) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);
