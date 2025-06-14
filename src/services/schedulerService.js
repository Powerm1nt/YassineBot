import { ToadScheduler, SimpleIntervalJob, AsyncTask } from 'toad-scheduler'
import { OpenAI } from 'openai/client.mjs'
import { format, addMinutes, getHours } from 'date-fns'
import dotenv from 'dotenv'
import { randomUUID } from 'crypto'
import { mcpUtils } from '../utils/mcpUtils.js'

// Use isUsingDeepSeekAPI from mcpUtils.js
const isUsingDeepSeekAPI = mcpUtils.isUsingDeepSeekAPI;
import { isGuildEnabled, isChannelTypeEnabled, isSchedulerEnabled } from '../utils/configService.js'
import { analysisService } from './analysisService.js'
import { taskService } from './taskService.js'
import { messageTaskService } from './messageTaskService.js'
const { prisma } = await import('./prisma.js');

dotenv.config()

const scheduler = new ToadScheduler()
const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_API_BASE_URL'] || 'https://api.openai.com/v1',
})

const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris'

export const CHANNEL_TYPES = {
  GUILD: 'guild',
  DM: 'dm',
  GROUP: 'group'
}

let previewedNextChannel = null

const MIN_DELAY = parseFloat(process.env.MIN_DELAY_MINUTES || '0.2') * 60 * 1000
const MAX_DELAY = parseFloat(process.env.MAX_DELAY_MINUTES || '2') * 60 * 1000
const MAX_ACTIVE_TASKS = parseInt(process.env.MAX_ACTIVE_TASKS || '100', 10)

const activeTasks = new Map()

function formatDate (date, formatStr = 'HH:mm:ss dd/MM/yyyy') {
  try {
    // Vérifier que date est un objet Date valide
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) {
      console.warn(`formatDate: Date invalide fournie: ${date}`);
      return 'Date invalide';
    }
    return format(dateObj, formatStr);
  } catch (error) {
    console.error(`Erreur lors du formatage de la date ${date}:`, error);
    return 'Erreur de date';
  }
}

function getCurrentHour () {
  return getHours(new Date())
}

export function formatDelay (ms) {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}


function selectRandomChannel(client, channelType = null) {
  const enabledTypes = [];

  if (isChannelTypeEnabled(CHANNEL_TYPES.GUILD)) enabledTypes.push(CHANNEL_TYPES.GUILD);
  if (isChannelTypeEnabled(CHANNEL_TYPES.DM)) enabledTypes.push(CHANNEL_TYPES.DM);
  if (isChannelTypeEnabled(CHANNEL_TYPES.GROUP)) enabledTypes.push(CHANNEL_TYPES.GROUP);

  if (enabledTypes.length === 0) {
    console.log('No channel type is enabled in the configuration');
    return null;
  }

  if (channelType) {
    if (!isChannelTypeEnabled(channelType)) {
      console.log(`Channel type ${channelType} is disabled in the configuration`);
      return null;
    }
  } else {
    channelType = enabledTypes[Math.floor(Math.random() * enabledTypes.length)];
  }

  switch (channelType) {
    case CHANNEL_TYPES.GUILD:
      return selectRandomGuildChannel(client);
    case CHANNEL_TYPES.DM:
      return selectRandomDMChannel(client);
    case CHANNEL_TYPES.GROUP:
      return selectRandomGroupChannel(client);
    default:
      console.log(`Unrecognized channel type: ${channelType}`);
      return null;
  }
}

/**
 * Sélectionne un canal aléatoire dans un serveur
 * @param {Object} client - Client Discord
 * @returns {Object|null} - Canal sélectionné ou null
 */
function selectRandomGuildChannel(client) {
  // Récupérer tous les serveurs avec lesquels le bot est présent
  const guilds = Array.from(client.guilds.cache.values())
    // Filtrer pour ne garder que les serveurs activés dans la configuration
    // et où l'analyse/auto-réponse est activée
    .filter(async guild => {
      return await isGuildEnabled(guild.id);
    });

  if (guilds.length === 0) {
    console.log('No server available or enabled in the configuration');
    return null;
  }

  // Choisir un serveur aléatoire
  const randomGuild = guilds[Math.floor(Math.random() * guilds.length)];

  // Récupérer tous les canaux textuels du serveur
  const textChannels = Array.from(randomGuild.channels.cache.values())
    .filter(channel => {
      if (channel.type === 'GUILD_TEXT') {
        const botMember = channel.guild.members.cache.get(client.user.id);
        return botMember && channel.permissionsFor(botMember).has('SEND_MESSAGES');
      }
      return false;
    });

  if (textChannels.length === 0) {
    console.log(`No accessible text channel in ${randomGuild.name}`);
    return null;
  }

  // Choisir un canal aléatoire
  const selectedChannel = textChannels[Math.floor(Math.random() * textChannels.length)];
  // Ajouter des métadonnées au canal pour les statistiques
  selectedChannel.channelInfo = {
    type: CHANNEL_TYPES.GUILD,
    name: selectedChannel.name,
    guildName: randomGuild.name,
    guildId: randomGuild.id
  };

  return selectedChannel;
}

/**
 * Sélectionne un canal de message privé aléatoire
 * @param {Object} client - Client Discord
 * @returns {Object|null} - Canal MP sélectionné ou null
 */
function selectRandomDMChannel(client) {
  // Récupérer tous les canaux de MPs
  const dmChannels = Array.from(client.channels.cache.values())
    .filter(channel => channel.type === 'DM' && !channel.recipient.bot);

  if (dmChannels.length === 0) {
    console.log('No private message channel available');
    return null;
  }

  // Choisir un canal MP aléatoire
  const selectedChannel = dmChannels[Math.floor(Math.random() * dmChannels.length)];
  // Ajouter des métadonnées au canal pour les statistiques
  selectedChannel.channelInfo = {
    type: CHANNEL_TYPES.DM,
    name: `Message privé avec ${selectedChannel.recipient.username}`,
    userId: selectedChannel.recipient.id,
    username: selectedChannel.recipient.username
  };

  return selectedChannel;
}

/**
 * Sélectionne un canal de groupe aléatoire
 * @param {Object} client - Client Discord
 * @returns {Object|null} - Canal de groupe sélectionné ou null
 */
function selectRandomGroupChannel(client) {
  // Récupérer tous les canaux de groupe
  const groupChannels = Array.from(client.channels.cache.values())
    .filter(channel => channel.type === 'GROUP_DM');

  if (groupChannels.length === 0) {
    console.log('No group channel available');
    return null;
  }

  // Choisir un canal de groupe aléatoire
  const selectedChannel = groupChannels[Math.floor(Math.random() * groupChannels.length)];
  // Ajouter des métadonnées au canal pour les statistiques
  selectedChannel.channelInfo = {
    type: CHANNEL_TYPES.GROUP,
    name: selectedChannel.name || 'Groupe privé',
    memberCount: selectedChannel.recipients?.length || 0
  };

  return selectedChannel;
}

/**
 * Sélectionne un utilisateur aléatoire dans un canal
 * @param {Object} channel - Canal Discord
 * @param {Object} client - Client Discord
 * @returns {Object|null} - Utilisateur sélectionné ou null
 */
async function selectRandomUser (channel, client) {
  try {
    // Récupérer les membres du canal
    const members = Array.from((await channel.guild.members.fetch()).values())
      .filter(member => !member.user.bot && member.id !== client.user.id)

    if (members.length === 0) {
      console.log(`No user available in ${channel.name}`)
      return null
    }

    // Choisir un membre aléatoire
    return members[Math.floor(Math.random() * members.length)]
  } catch (error) {
    console.error('Erreur lors de la sélection d\'un utilisateur:', error)
    return null
  }
}

/**
 * Vérifie si l'heure actuelle est dans la plage horaire active (8h-23h par défaut)
 * @param {number} startHour - Heure de début (défaut: 8)
 * @param {number} endHour - Heure de fin (défaut: 23)
 * @returns {boolean} - true si dans la plage active
 */
function isActiveHour (startHour = 8, endHour = 23) {
  const currentHour = getCurrentHour()
  return currentHour >= startHour && currentHour < endHour
}

/**
 * Initialise les gestionnaires de tâches spécifiques
 */
export async function initTaskHandlers() {
  console.log('[Scheduler] Initializing specific task handlers...');

  // Gestionnaire pour les tâches d'analyse
  const analysisTaskHandler = new AsyncTask(
    'analysis-task-handler',
    async () => {
      try {
        // Récupérer toutes les tâches d'analyse en attente
        const analysisTasks = await taskService.getTasksByType('analysis');

        if (analysisTasks.length === 0) {
          return;
        }

        console.log(`[Scheduler] ${analysisTasks.length} analysis tasks to process`);

        // Traiter chaque tâche d'analyse
        for (const task of analysisTasks) {
          // Vérifier si la tâche est prête à être exécutée
          if (new Date(task.nextExecution) <= new Date()) {
            console.log(`[Scheduler] Processing analysis task ${task.schedulerId}`);

            try {
              // Mettre à jour le statut de la tâche
              await taskService.updateTaskStatus(task.schedulerId, 'running');

              // Exécuter l'analyse
              const { executeScheduledAnalysis } = await import('./analysisService.js');
              const analysisResult = await executeScheduledAnalysis(task.data);

              console.log(`[Scheduler] Analysis completed - Result: ${JSON.stringify(analysisResult)}`);

              // Marquer la tâche comme terminée
              await taskService.updateTaskStatus(task.schedulerId, 'completed');

              // Supprimer la tâche terminée
              await taskService.deleteTask(task.schedulerId);
            } catch (error) {
              console.error(`[Scheduler] Erreur lors du traitement de la tâche d'analyse ${task.schedulerId}:`, error);
              await taskService.updateTaskStatus(task.schedulerId, 'failed');
            }
          }
        }
      } catch (error) {
        console.error('[Scheduler] Erreur dans le gestionnaire de tâches d\'analyse:', error);
      }
    }
  );

  // Ajouter la tâche au planificateur pour qu'elle s'exécute toutes les 5 secondes
  const analysisJob = new SimpleIntervalJob({ seconds: 5 }, analysisTaskHandler);
  scheduler.addSimpleIntervalJob(analysisJob);

  console.log('[Scheduler] Specific task handlers initialized');
}

/**
 * Initialise le planificateur de tâches avec une approche basée prioritairement sur la base de données
 * @param {Object} client - Client Discord
 */
export async function initScheduler(client) {
  console.log('[Scheduler] Initializing task scheduler...')
  // Vérifier si les messages automatiques sont activés
  if (!(await isSchedulerEnabled()) || process.env.ENABLE_AUTO_MESSAGES !== 'true') {
    console.log('[Scheduler] Automatic messages are disabled - Scheduler not initialized')
    return
  }

  // Nettoyer les tâches existantes du planificateur (mais pas de la base de données)
  await stopScheduler()

  const currentTime = formatDate(new Date(), 'HH:mm:ss')
  console.log(`Scheduler initialized at ${currentTime} with system timezone (${TIMEZONE} configured)`)
  console.log(`Configuration: delay: ${formatDelay(MIN_DELAY)}-${formatDelay(MAX_DELAY)}`)

  try {
    // Vérifier l'accès à la base de données
    let dbAccessible;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAccessible = true;
    } catch (dbError) {
      console.error('Erreur d\'accès à la base de données:', dbError.message);
      dbAccessible = false;
    }

    if (!dbAccessible) {
      console.warn('Impossible de créer des tâches planifiées - pas d\'accès à la base de données');
      return;
    }

    // Nettoyer les tâches expirées dans la base de données
    const cleanedExpired = await taskService.cleanupExpiredTasks();

    // Nettoyer les tâches terminées (completed ou failed)
    const cleanedFinished = await taskService.cleanupFinishedTasks();
    console.log(`[Scheduler] ${cleanedExpired} expired tasks and ${cleanedFinished} finished tasks cleaned up`);

    // Synchroniser le cache mémoire avec la base de données
    const restoredCount = await taskService.syncMemoryCache();
    console.log(`[Scheduler] Task service initialized: ${cleanedExpired + cleanedFinished} tasks cleaned up, ${restoredCount} tasks restored in memory`);

    // Initialiser les gestionnaires de tâches spécifiques
    await initTaskHandlers();

    // Supprimer les anciennes tâches de type random-question-task qui n'existent plus
    try {
      const deletedCount = await taskService.deleteTasksByType('random-question-task');
      if (deletedCount > 0) {
        console.log(`[Scheduler] ${deletedCount} old random question tasks deleted`);
      }
    } catch (deleteError) {
      console.error('[Scheduler] Erreur lors de la suppression des anciennes tâches:', deleteError);
    }

    // Restaurer les tâches non expirées depuis la base de données
    await restorePendingTasks(client);

    // Vérifier s'il existe déjà une tâche d'analyse active
    const existingAnalysisTasks = await taskService.getTasksByType('analysis-task');
    if (existingAnalysisTasks.length > 0) {
      console.log(`[Scheduler] ${existingAnalysisTasks.length} existing analysis tasks found in database`);

      // Si les tâches sont expirées ou arrêtées, les supprimer et en créer de nouvelles
      const now = new Date();
      const activeTask = existingAnalysisTasks.find(task => 
        task.status === 'pending' && task.nextExecution && new Date(task.nextExecution) > now
      );

      if (activeTask) {
        console.log(`[Scheduler] Active analysis task found (ID: ${activeTask.schedulerId}), rescheduling not necessary`);
        // Ajouter à la liste des tâches actives en mémoire
        activeTasks.set(activeTask.schedulerId, {
          taskNumber: activeTask.taskNumber || 1,
          nextExecution: new Date(activeTask.nextExecution),
          targetChannelType: activeTask.targetChannelType,
          taskData: activeTask
        });
      } else {
        console.log('[Scheduler] No active analysis task found, deleting expired tasks and creating a new one');
        // Supprimer les tâches expirées ou arrêtées
        for (const task of existingAnalysisTasks) {
          await taskService.deleteTask(task.schedulerId);
        }
      }
    }

    console.log('[Scheduler] Scheduler initialization completed. Message tasks will be created by the analysis service if needed.');
  } catch (error) {
    console.error('[Scheduler] Error during scheduler initialization:', error);
  }
}

/**
 * Crée une tâche planifiée avec un délai aléatoire
 * @param {Object} client - Client Discord
 * @param {number} taskNumber - Numéro de la tâche (pour identification)
 */
/**
 * Crée une tâche d'analyse et de réponse aux conversations récentes
 * @param {Object} client - Client Discord
 * @param {number} taskNumber - Numéro de la tâche
 */
async function createAnalysisTask(client, taskNumber) {
  // Générer un identifiant unique pour cette tâche
  const taskId = `analysis-task-${taskNumber}-${randomUUID().substring(0, 8)}`;

  console.log(`[Scheduler] Creating a new analysis task: ${taskId}`);

  // Créer la tâche asynchrone
  const task = new AsyncTask(
    taskId,
    async () => {
      try {
        console.log('[Scheduler] Executing conversation analysis task');

        // Mettre à jour le statut de la tâche dans la base de données
        await taskService.updateTaskStatus(taskId, 'running');

        // Traiter les tâches intermédiaires (analyse des messages capturés)
        const processedTasks = await messageTaskService.processIntermediateTasks();
        console.log(`[Scheduler] ${processedTasks} intermediate tasks processed`);

        // Exécuter les tâches de réponse
        const executedTasks = await messageTaskService.executeResponseTasks(client);
        console.log(`[Scheduler] ${executedTasks} response tasks executed`);

        // Vérifier si nous sommes dans les heures actives
        if (!isActiveHour()) {
          const currentTime = formatDate(new Date(), 'HH:mm');
          console.log(`[Scheduler] Analysis task skipped - Outside active hours (${currentTime})`);
          // Marquer comme terminée même si ignorée
          await taskService.updateTaskStatus(taskId, 'completed');
          return;
        }

        console.log('[Scheduler] Analysis task executing - Within active hours');

        // Récupérer aussi les tâches de conversation planifiées en utilisant directement la base de données
        // pour avoir les données les plus récentes
        const pendingTasks = await taskService.getTasksByType('conversation');
        if (pendingTasks && pendingTasks.length > 0) {
          console.log(`Processing ${pendingTasks.length} scheduled conversation tasks...`);

          for (const task of pendingTasks) {
            if (task.data && task.data.channelId) {
              try {
                // Mettre à jour le statut de la tâche avant de la traiter
                await taskService.updateTaskStatus(task.schedulerId, 'running');

                const channel = await client.channels.fetch(task.data.channelId).catch(() => null);

                if (channel) {
                  // Générer une réponse ou une question basée sur le sujet stocké
                  const topicSummary = task.data.topicSummary || 'conversation en cours';
                  const shouldAskQuestion = Math.random() > 0.5; // 50% de chance de poser une question

                  let messageContent;
                  if (shouldAskQuestion) {
                    // Récupérer les messages récents pour le contexte
                    const recentMessages = await conversationService.getRecentMessages(
                      task.data.channelId, 
                      task.data.guildId || null,
                      10
                    );

                    // Générer une question sur le sujet
                    messageContent = await generateFollowUpQuestion(recentMessages, topicSummary);
                  } else {
                    // Générer un commentaire sur le sujet
                    messageContent = await generateTopicComment([], topicSummary);
                  }

                  // Vérifier si le message a du contenu
                  if (messageContent && messageContent.trim() !== '') {
                    // Simuler l'écriture
                    await channel.sendTyping().catch(console.error);

                    // Délai calculé en fonction de la longueur du message
                    const typingDelay = messageContent.length * 30 + Math.floor(Math.random() * 2000);
                    await new Promise(resolve => setTimeout(resolve, typingDelay));

                    // Envoyer le message
                    await channel.send(messageContent);

                    console.log(`Follow-up message sent in ${task.data.channelId} on topic: ${topicSummary}`);
                  }
                }

                // Marquer la tâche comme terminée avant de la supprimer
                await taskService.updateTaskStatus(task.schedulerId, 'completed');
                // Supprimer la tâche une fois traitée
                await taskService.deleteTask(task.schedulerId);

              } catch (taskError) {
                console.error(`Erreur lors du traitement de la tâche de conversation ${task.schedulerId}:`, taskError);
                // Marquer la tâche comme échouée
                await taskService.updateTaskStatus(task.schedulerId, 'failed');
                // Supprimer la tâche en cas d'erreur pour éviter les tentatives répétées
                await taskService.deleteTask(task.schedulerId);
              }
            }
          }
        }

        // Récupérer les conversations récemment actives
        const recentConversations = await prisma.conversation.findMany({
          where: {
            updatedAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Dernières 24 heures
            }
          },
          orderBy: {
            updatedAt: 'desc'
          },
          take: 5,
          include: {
            messages: {
              orderBy: {
                createdAt: 'desc'
              },
              take: 20
            }
          }
        });

        if (recentConversations.length === 0) {
          console.log('No recent conversation to analyze');
          // Marquer la tâche comme terminée
          await taskService.updateTaskStatus(taskId, 'completed');
          return;
        }

        // Sélectionner une conversation au hasard parmi les récentes
        const randomIndex = Math.floor(Math.random() * recentConversations.length);
        const selectedConversation = recentConversations[randomIndex];

        // Analyser la pertinence de la conversation
        const analysis = await analysisService.analyzeConversationRelevance(selectedConversation.messages);

        // Mettre à jour le score de pertinence de la conversation
        await prisma.conversation.update({
          where: { id: selectedConversation.id },
          data: {
            relevanceScore: analysis.relevanceScore,
            topicSummary: analysis.topicSummary,
            updatedAt: new Date()
          }
        });

        // Si la réponse automatique est activée et que la conversation est pertinente
        if (autoRespondEnabled && analysis.relevanceScore >= 0.6) {
          // Trouver le canal correspondant
          const channel = await client.channels.fetch(selectedConversation.channelId).catch(() => null);

          if (channel) {
            // Générer une réponse ou une question basée sur le sujet
            const shouldAskQuestion = Math.random() > 0.5; // 50% de chance de poser une question

            let messageContent;
            if (shouldAskQuestion) {
              // Générer une question sur le sujet
              const question = await generateFollowUpQuestion(selectedConversation.messages, analysis.topicSummary);
              messageContent = question;
            } else {
              // Générer un commentaire sur le sujet
              const comment = await generateTopicComment(selectedConversation.messages, analysis.topicSummary);
              messageContent = comment;
            }

            // Vérifier si le message a du contenu
            if (messageContent && messageContent.trim() !== '') {
              // Délai aléatoire pour sembler plus naturel
              await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3000) + 1000));

              // Simuler l'écriture
              await channel.sendTyping().catch(console.error);

              // Délai calculé en fonction de la longueur du message
              const typingDelay = messageContent.length * 30 + Math.floor(Math.random() * 2000);
              await new Promise(resolve => setTimeout(resolve, typingDelay));

              // Envoyer le message
              await channel.send(messageContent);

              console.log(`Automatic message sent in ${selectedConversation.channelId} on topic: ${analysis.topicSummary}`);
            }
          }
        }

        console.log(`Conversation ${selectedConversation.id} analyzed, score: ${analysis.relevanceScore}, topic: ${analysis.topicSummary}`);

        // Marquer la tâche comme terminée
        await taskService.updateTaskStatus(taskId, 'completed');

        // Créer une nouvelle tâche d'analyse pour continuer le cycle
        await createAnalysisTask(client, taskNumber);
      } catch (error) {
        console.error('Erreur lors de l\'exécution de la tâche d\'analyse:', error);
        // Marquer la tâche comme échouée
        await taskService.updateTaskStatus(taskId, 'failed');

        // Malgré l'erreur, créer une nouvelle tâche d'analyse pour continuer le cycle
        await createAnalysisTask(client, taskNumber);
      }
    },
    (err) => {
      console.error('Erreur dans la tâche d\'analyse:', err);
      // En cas d'erreur dans le callback, marquer la tâche comme échouée
      taskService.updateTaskStatus(taskId, 'failed')
        .catch(updateErr => console.error('Erreur lors de la mise à jour du statut de tâche:', updateErr));
    }
  );

  // Générer un délai aléatoire pour l'analyse en utilisant les constantes globales
  const minDelayMs = MIN_DELAY; // Utilise la constante globale déjà en millisecondes
  const maxDelayMs = MAX_DELAY; // Utilise la constante globale déjà en millisecondes
  const analysisDelay = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
  const nextExecutionTime = addMinutes(new Date(), Math.floor(analysisDelay / 60000));

  console.log(`[Analysis task ${taskNumber}] Scheduled for ${formatDate(nextExecutionTime, 'HH:mm:ss')}`);

  // Créer un job pour l'analyse
  const job = new SimpleIntervalJob(
    { milliseconds: analysisDelay, runImmediately: false },
    task,
    taskId
  );

  // Ajouter le job au planificateur
  scheduler.addSimpleIntervalJob(job);

  // Enregistrer la tâche dans la base de données et le cache mémoire
  try {
    const savedTask = await taskService.saveTask(taskId, taskNumber, nextExecutionTime, null, 'analysis', {
      type: 'analysis',
      status: 'pending',
      createdAt: new Date().toISOString()
    });

    // Ajouter aussi dans le registre interne des tâches actives
    activeTasks.set(taskId, {
      taskNumber,
      nextExecution: nextExecutionTime,
      targetChannelType: null,
      taskData: savedTask
    });

    console.log(`[Scheduler] Analysis task ${taskId} registered in database and memory cache`);
  } catch (error) {
    console.warn(`Error while registering analysis task ${taskId}:`, error.message);
  }

  return taskId;
}

/**
 * Génère une question de suivi basée sur la conversation
 * @param {Array} messages - Messages de la conversation
 * @param {string} topicSummary - Résumé du sujet
 * @returns {Promise<string>} - Question générée
 */
async function generateFollowUpQuestion(messages, topicSummary) {
  try {
    const systemInstructions = `Tu es un assistant Discord amical et curieux. Génère une question de suivi naturelle et engageante basée sur la conversation récente.

La question doit:
- Être liée au sujet principal: "${topicSummary}"
- Sembler naturelle dans le flux de la conversation
- Encourager plus de discussion
- Être courte et directe (max 1-2 phrases)
- Éviter d'être trop formelle ou académique

Ne pas inclure d'introduction comme "Alors," ou "Au fait,". Donne simplement la question.`;

    // Préparer les derniers messages comme contexte
    // Note: Nous utilisons directement les messages passés en paramètre plutôt que de faire un appel à la base de données
    // car le contexte est déjà créé avec l'API OpenAI et nous avons besoin de formater les messages d'une manière spécifique
    const recentMessages = messages.slice(-10).map(msg => `${msg.userName}: ${msg.content}`).join('\n');

    let response;

    // Vérifier si on utilise l'API DeepSeek
    if (isUsingDeepSeekAPI()) {
      console.log(`[SchedulerService] Using DeepSeek API with chat.completions.create for follow-up question`);

      // Convertir les paramètres pour l'API Chat Completions
      const chatResponse = await openai.chat.completions.create({
        model: process.env.GPT_MODEL || 'gpt-4.1-mini',
        messages: [
          {
            role: "system",
            content: systemInstructions
          },
          {
            role: "user",
            content: `Conversation récente:\n${recentMessages}\n\nSujet principal: ${topicSummary}`
          }
        ],
        max_tokens: 100 // Limite appropriée pour les questions courtes
      });

      // Construire un objet de réponse compatible avec le format attendu
      response = {
        output_text: chatResponse.choices[0]?.message?.content || ''
      };
    } else {
      // Utiliser l'API Assistants standard
      response = await openai.responses.create({
        model: process.env.GPT_MODEL || 'gpt-4.1-mini',
        input: `Conversation récente:\n${recentMessages}\n\nSujet principal: ${topicSummary}`,
        instructions: systemInstructions,
        max_tokens: 100 // Limite appropriée pour les questions courtes
      });
    }

    return response.output_text || 'Qu\'en pensez-vous?';
  } catch (error) {
    console.error('Erreur lors de la génération de question de suivi:', error);
    return 'Des réflexions sur ce sujet?';
  }
}

/**
 * Génère un commentaire sur le sujet de la conversation
 * @param {Array} messages - Messages de la conversation
 * @param {string} topicSummary - Résumé du sujet
 * @returns {Promise<string>} - Commentaire généré
 */
async function generateTopicComment(messages, topicSummary) {
  try {
    const systemInstructions = `Tu es un assistant Discord amical et attentionné. Génère un commentaire naturel et pertinent basé sur la conversation récente.

Le commentaire doit:
- Être lié au sujet principal: "${topicSummary}"
- Ajouter de la valeur à la conversation
- Sembler naturel et conversationnel
- Être court et direct (1-2 phrases)
- Éviter d'être trop formel ou académique

Ne pas inclure d'introduction comme "Je pense que" ou "À mon avis". Donne simplement le commentaire direct.`;

    // Préparer les derniers messages comme contexte
    // Note: Nous utilisons directement les messages passés en paramètre plutôt que de faire un appel à la base de données
    // car le contexte est déjà créé avec l'API OpenAI et nous avons besoin de formater les messages d'une manière spécifique
    const recentMessages = messages.slice(-10).map(msg => `${msg.userName}: ${msg.content}`).join('\n');

    let response;

    // Vérifier si on utilise l'API DeepSeek
    if (isUsingDeepSeekAPI()) {
      console.log(`[SchedulerService] Using DeepSeek API with chat.completions.create for topic comment`);

      // Convertir les paramètres pour l'API Chat Completions
      const chatResponse = await openai.chat.completions.create({
        model: process.env.GPT_MODEL || 'gpt-4.1-mini',
        messages: [
          {
            role: "system",
            content: systemInstructions
          },
          {
            role: "user",
            content: `Conversation récente:\n${recentMessages}\n\nSujet principal: ${topicSummary}`
          }
        ],
        max_tokens: 100 // Limite appropriée pour les commentaires courts
      });

      // Construire un objet de réponse compatible avec le format attendu
      response = {
        output_text: chatResponse.choices[0]?.message?.content || ''
      };
    } else {
      // Utiliser l'API Assistants standard
      response = await openai.responses.create({
        model: process.env.GPT_MODEL || 'gpt-4.1-mini',
        input: `Conversation récente:\n${recentMessages}\n\nSujet principal: ${topicSummary}`,
        instructions: systemInstructions,
        max_tokens: 100 // Limite appropriée pour les commentaires courts
      });
    }

    return response.output_text || 'Intéressant.';
  } catch (error) {
    console.error('Erreur lors de la génération de commentaire:', error);
    return 'Très intéressant.';
  }
}


/**
 * Prévisualise le prochain canal qui sera utilisé pour envoyer un message
 * @param {Object} client - Client Discord
 * @returns {Object|null} - Information sur le canal prévisualisé
 */
export function getNextChannel(client) {
  try {
    // Si nous avons déjà une prévisualisation et qu'elle est récente (< 5 minutes), la réutiliser
    if (previewedNextChannel && (new Date() - previewedNextChannel.timestamp) < 300000) {
      return previewedNextChannel.info;
    }

    // Sinon, sélectionner un nouveau canal aléatoire
    const channelType = process.env.TARGET_CHANNEL_TYPE || null;
    const channel = selectRandomChannel(client, channelType);

    if (!channel) {
      return null;
    }

    // Stocker l'information et l'horodatage
    previewedNextChannel = {
      timestamp: new Date(),
      info: {
        ...channel.channelInfo,
        preview: true
      }
    };

    return previewedNextChannel.info;
  } catch (error) {
    console.error('Erreur lors de la prévisualisation du canal:', error);
    return null;
  }
}

/**
 * Récupère la configuration complète des canaux
 * @returns {Object} - Configuration des canaux
 */
export function getChannelConfig() {
  return {
    channelTypes: {
      guild: isChannelTypeEnabled(CHANNEL_TYPES.GUILD),
      dm: isChannelTypeEnabled(CHANNEL_TYPES.DM),
      group: isChannelTypeEnabled(CHANNEL_TYPES.GROUP)
    }
  };
}

/**
 * Récupère l'état actuel du planificateur en combinant les tâches de la base de données et du cache mémoire
 * @returns {Promise<Object>} - État du planificateur
 */
export async function getSchedulerStatus() {
  const now = new Date();
  const tasks = [];
  let nextTask = null;
  let minTimeLeft = Infinity;

  try {
    // Synchroniser le cache mémoire avec la base de données pour avoir les données les plus récentes
    await taskService.syncMemoryCache();

    // Utiliser les tâches en mémoire (qui sont maintenant synchronisées avec la base de données)
    for (const [taskId, taskInfo] of activeTasks.entries()) {
      const timeUntilExecution = taskInfo.nextExecution - now;
      const formattedTimeLeft = formatDelay(timeUntilExecution > 0 ? timeUntilExecution : 0);
      const shortId = taskId.split('-').pop(); // Prendre juste la dernière partie de l'ID

      const taskData = {
        id: shortId,
        taskId: taskId,
        number: taskInfo.taskNumber,
        nextExecution: formatDate(taskInfo.nextExecution, 'HH:mm:ss'),
        nextExecutionFull: formatDate(taskInfo.nextExecution, 'HH:mm:ss dd/MM/yyyy'),
        timeLeft: formattedTimeLeft,
        timeLeftMs: timeUntilExecution > 0 ? timeUntilExecution : 0,
        targetChannelType: taskInfo.targetChannelType || 'aléatoire',
        targetChannel: taskInfo.targetChannel || null,
        targetUser: taskInfo.targetUser || null
      };

      tasks.push(taskData);

      // Trouver la tâche qui s'exécutera en premier
      if (timeUntilExecution > 0 && timeUntilExecution < minTimeLeft) {
        minTimeLeft = timeUntilExecution;
        nextTask = taskData;
      }
    }

    // Si le cache mémoire est vide, récupérer les tâches directement de la base de données
    if (tasks.length === 0) {
      const dbTasks = await taskService.getAllTasks();

      for (const task of dbTasks) {
        if (task.nextExecution) {
          const timeUntilExecution = new Date(task.nextExecution) - now;
          const formattedTimeLeft = formatDelay(timeUntilExecution > 0 ? timeUntilExecution : 0);
          const shortId = task.schedulerId.split('-').pop();

          const taskData = {
            id: shortId,
            taskId: task.schedulerId,
            number: task.taskNumber,
            nextExecution: formatDate(task.nextExecution, 'HH:mm:ss'),
            nextExecutionFull: formatDate(task.nextExecution, 'HH:mm:ss dd/MM/yyyy'),
            timeLeft: formattedTimeLeft,
            timeLeftMs: timeUntilExecution > 0 ? timeUntilExecution : 0,
            targetChannelType: task.targetChannelType || 'aléatoire',
            targetChannel: task.data.targetChannel || null,
            targetUser: task.data.targetUser || null
          };

          tasks.push(taskData);

          // Trouver la tâche qui s'exécutera en premier
          if (timeUntilExecution > 0 && timeUntilExecution < minTimeLeft) {
            minTimeLeft = timeUntilExecution;
            nextTask = taskData;
          }
        }
      }
    }

    // Trier les tâches par temps restant
    tasks.sort((a, b) => a.timeLeftMs - b.timeLeftMs);

    const isInActiveHours = isActiveHour();
    const currentHour = getCurrentHour();

    return {
      active: tasks.length > 0,
      taskCount: tasks.length,
      currentTime: formatDate(now, 'HH:mm:ss'),
      timezone: TIMEZONE,
      inActiveHours: isInActiveHours,
      currentHour: currentHour,
      nextTask: nextTask,
      nextChannel: previewedNextChannel ? previewedNextChannel.info : null,
      config: {
        minDelay: formatDelay(MIN_DELAY),
        maxDelay: formatDelay(MAX_DELAY),
        activeHours: '8h-23h' // À personnaliser si vous changez isActiveHour
      },
      tasks: tasks
    };
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'état du planificateur:', error);

    // En cas d'erreur, retourner un état minimal
    return {
      active: activeTasks.size > 0,
      taskCount: activeTasks.size,
      currentTime: formatDate(now, 'HH:mm:ss'),
      timezone: TIMEZONE,
      error: 'Erreur lors de la récupération des tâches',
      inActiveHours: isActiveHour(),
      currentHour: getCurrentHour(),
      config: {
        minDelay: formatDelay(MIN_DELAY),
        maxDelay: formatDelay(MAX_DELAY),
        activeHours: '8h-23h'
      },
      tasks: []
    };
  }
}

/**
 * Arrête le planificateur de tâches
 */
/**
  * Modifie le type de canal cible d'une tâche spécifique
  * @param {number} taskNumber - Numéro de la tâche à modifier
  * @param {string} channelType - Nouveau type de canal
  * @returns {boolean} - true si la modification a réussi
  */
 export function setTaskChannelType(taskNumber, channelType) {
   // Vérifier si le type de canal est valide ou null (aléatoire)
   if (channelType !== null && !Object.values(CHANNEL_TYPES).includes(channelType)) {
     return false;
   }

   // Rechercher la tâche
   for (const [taskId, taskInfo] of activeTasks.entries()) {
     if (taskInfo.taskNumber === taskNumber) {
       // Mettre à jour le type de canal
       taskInfo.targetChannelType = channelType;
       activeTasks.set(taskId, taskInfo);
       return true;
     }
   }

   return false;
 }

 /**
 * Récupère une tâche spécifique par son numéro
 * @param {number} taskNumber - Numéro de la tâche à récupérer
 * @returns {Object|null} - La tâche ou null si non trouvée
 */
/**
 * Obtient les statistiques de ciblage pour les canaux et utilisateurs
 * @returns {Object} Statistiques détaillées
 */
export function getTargetingStats() {
  // Initialiser les compteurs
  const stats = {
    channels: {
      guild: { count: 0, names: {} },
      dm: { count: 0, names: {} },
      group: { count: 0, names: {} },
      pending: 0
    },
    users: {
      count: 0,
      names: {}
    },
    guilds: {
      count: 0,
      names: {}
    }
  };

  // Parcourir toutes les tâches actives
  for (const [taskId, taskInfo] of activeTasks.entries()) {
    if (taskInfo.targetChannel) {
      const channelType = taskInfo.targetChannel.type;

      // Compter par type de canal
      if (stats.channels[channelType]) {
        stats.channels[channelType].count++;

        // Compter les occurrences de chaque nom de canal
        const channelName = taskInfo.targetChannel.name || 'Sans nom';
        stats.channels[channelType].names[channelName] =
          (stats.channels[channelType].names[channelName] || 0) + 1;

        // Pour les canaux de serveur, compter aussi les serveurs
        if (channelType === 'guild' && taskInfo.targetChannel.guildName) {
          stats.guilds.count++;
          stats.guilds.names[taskInfo.targetChannel.guildName] =
            (stats.guilds.names[taskInfo.targetChannel.guildName] || 0) + 1;
        }
      }

      // Compter les utilisateurs ciblés
      if (taskInfo.targetUser) {
        stats.users.count++;
        const username = taskInfo.targetUser.username || 'Inconnu';
        stats.users.names[username] = (stats.users.names[username] || 0) + 1;
      }
    } else {
      stats.channels.pending++;
    }
  }

  return stats;
}

export function getTaskByNumber (taskNumber) {
  for (const [taskId, taskInfo] of activeTasks.entries()) {
    if (taskInfo.taskNumber === taskNumber) {
      const now = new Date()
      const timeUntilExecution = taskInfo.nextExecution - now

      return {
        id: taskId,
        number: taskInfo.taskNumber,
        nextExecution: formatDate(taskInfo.nextExecution, 'HH:mm:ss'),
        nextExecutionFull: formatDate(taskInfo.nextExecution, 'HH:mm:ss dd/MM/yyyy'),
        timeLeft: formatDelay(timeUntilExecution > 0 ? timeUntilExecution : 0),
        timeLeftMs: timeUntilExecution > 0 ? timeUntilExecution : 0
      }
    }
  }

  return null
}

/**
 * Définit le type de canal cible par défaut pour les nouvelles tâches
 * @param {string} channelType - Type de canal (guild, dm, group)
 */
export function setDefaultChannelType(channelType) {
  // Vérifier si le type de canal est valide
  if (!Object.values(CHANNEL_TYPES).includes(channelType)) {
    throw new Error(`Invalid channel type: ${channelType}. Use: ${Object.values(CHANNEL_TYPES).join(', ')}`);
  }

  process.env.TARGET_CHANNEL_TYPE = channelType;
  console.log(`Default target channel type set to: ${channelType}`);
}

export async function stopScheduler() {
  console.log('Stopping task scheduler...');

  // Supprimer chaque tâche individuellement du planificateur
  for (const [taskId, taskInfo] of activeTasks.entries()) {
    try {
      scheduler.removeById(taskId);
      console.log(`Task ${taskId} removed from scheduler`);

      // Marquer la tâche comme terminée dans la base de données
      await taskService.updateTaskStatus(taskId, 'completed');
    } catch (e) {
      // Ignorer si la tâche n'existe pas dans le planificateur
      console.log(`Unable to remove task ${taskId} from scheduler: ${e.message}`);
    }
  }

  // Vider le registre des tâches en mémoire
  activeTasks.clear();

  // Arrêter complètement le planificateur pour être sûr
  scheduler.stop();

  // Ne pas supprimer les tâches de la base de données pour permettre leur restauration ultérieure
  // si nécessaire, mais mettre à jour leur statut
  try {
    await prisma.task.updateMany({
      where: {
        type: 'scheduler',
        status: 'pending'
      },
      data: {
        status: 'stopped',
        updatedAt: new Date()
      }
    });
  } catch (dbError) {
    console.error('Error updating task status in database:', dbError);
  }

  console.log('Task scheduler stopped - all tasks have been removed from the scheduler and marked as stopped in the database');
}

/**
 * Nettoie les tâches expirées dans la base de données
 * @returns {Promise<void>}
 */
async function cleanupExpiredTasks() {
  try {
    // Utiliser la méthode du taskService pour nettoyer les tâches expirées
    const count = await taskService.cleanupExpiredTasks();
    console.log(`${count} expired tasks removed from database and memory cache`);
  } catch (error) {
    console.error('Error cleaning up expired tasks:', error);
  }
}

/**
 * Restaure les tâches non expirées depuis la base de données
 * @param {Object} client - Client Discord
 * @returns {Promise<number>} Le nombre de tâches restaurées
 */
async function restorePendingTasks(client) {
  try {
    const now = new Date();

    // Nettoyer les tâches terminées ou échouées avant de restaurer
    const cleanedTasks = await prisma.task.deleteMany({
      where: {
        status: { in: ['completed', 'failed'] }
      }
    });
    console.log(`[Scheduler] ${cleanedTasks.count} completed or failed tasks cleaned up before restoration`);

    // Nettoyer les tâches expirées
    const expiredTasks = await prisma.task.deleteMany({
      where: {
        nextExecution: {
          lt: now // Tâches dont la date d'exécution est passée
        }
      }
    });
    console.log(`[Scheduler] ${expiredTasks.count} expired tasks cleaned up before restoration`);

    // Récupérer toutes les tâches non expirées
    const pendingTasks = await prisma.task.findMany({
      where: {
        nextExecution: {
          gte: now // Seulement les tâches dont la date d'exécution est future
        },
        status: 'pending' // Seulement les tâches en attente
      }
    });

    if (pendingTasks.length === 0) {
      console.log('[Scheduler] No pending tasks to restore');
      return 0;
    }

    console.log(`[Scheduler] Restoring ${pendingTasks.length} pending tasks...`);

    // Le cache mémoire est déjà synchronisé par initializeTaskService
    let restoredCount = 0;

    for (const task of pendingTasks) {
      try {
        if (!task.schedulerId) {
          console.warn(`[Scheduler] Tâche sans schedulerId trouvée (ID: ${task.id}), ignorée`);
          continue;
        }

        // Recréer la tâche dans le planificateur en fonction de son type
        if (task.schedulerId.includes('analysis-task')) {
          // Recréer la tâche d'analyse
          await createAnalysisTask(client, task.taskNumber || 1);
          restoredCount++;
        } else if (task.schedulerId.includes('conversation-task')) {
          // Les tâches de conversation sont gérées par analysisService (anciennement messageMonitoringService)
          console.log(`[Scheduler] Conversation task ${task.schedulerId} restored, will be processed by the analyzer`);

          // S'assurer que la tâche est à jour dans le cache mémoire des tâches actives
          if (!activeTasks.has(task.schedulerId)) {
            activeTasks.set(task.schedulerId, {
              taskNumber: task.taskNumber,
              nextExecution: task.nextExecution,
              targetChannelType: task.targetChannelType,
              data: task.data
            });
          }
          restoredCount++;
        } else {
          // Autres types de tâches
          console.log(`[Scheduler] Unknown task type ${task.schedulerId} restored in memory`);
          if (!activeTasks.has(task.schedulerId)) {
            activeTasks.set(task.schedulerId, {
              taskNumber: task.taskNumber,
              nextExecution: task.nextExecution,
              targetChannelType: task.targetChannelType,
              data: task.data
            });
          }
          restoredCount++;
        }
      } catch (taskError) {
        console.error(`[Scheduler] Error restoring task ${task.schedulerId}:`, taskError);
      }
    }

    console.log(`[Scheduler] Task restoration completed (${restoredCount}/${pendingTasks.length} restored)`);
    return restoredCount;
  } catch (error) {
    console.error('[Scheduler] Error restoring pending tasks:', error);
    return 0;
  }
}
