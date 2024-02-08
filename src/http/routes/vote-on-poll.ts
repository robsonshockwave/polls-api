import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { FastifyInstance } from 'fastify';
import { redis } from '../../lib/redis';
import { votingPubSub } from '../../utils/voting-pub-sub';

export async function voteOnPoll(app: FastifyInstance) {
  app.post('/polls/:pollId/votes', async (request, reply) => {
    const voteOnPollBody = z.object({
      pollOptionId: z.string().uuid(),
    });

    const voteOnPollParams = z.object({
      pollId: z.string().uuid(),
    });

    const { pollOptionId } = voteOnPollBody.parse(request.body);
    const { pollId } = voteOnPollParams.parse(request.params);

    let sessionId = request.cookies.sessionId;

    if (sessionId) {
      const userPreviousVoteOnPoll = await prisma.vote.findUnique({
        where: {
          pollId_sessionId: {
            pollId,
            sessionId,
          },
        },
      });

      if (
        userPreviousVoteOnPoll &&
        userPreviousVoteOnPoll.pollOptionId !== pollOptionId
      ) {
        // Apagar o voto anterior
        await prisma.vote.delete({
          where: {
            id: userPreviousVoteOnPoll.id,
          },
        });

        const votes = await redis.zincrby(
          pollId,
          -1,
          userPreviousVoteOnPoll.pollOptionId
        );

        votingPubSub.publish(pollId, {
          pollOptionId: userPreviousVoteOnPoll.pollOptionId,
          votes: Number(votes),
        });
      } else if (userPreviousVoteOnPoll) {
        return reply.status(400).send({
          error: 'User already voted on this poll',
        });
      }
    }

    if (!sessionId) {
      sessionId = randomUUID();

      reply.setCookie('sessionId', sessionId, {
        path: '/',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        signed: true,
        httpOnly: true,
      });
    }

    // Criar um novo voto
    await prisma.vote.create({
      data: {
        pollId,
        pollOptionId,
        sessionId,
      },
    });

    const votes = await redis.zincrby(pollId, 1, pollOptionId);

    votingPubSub.publish(pollId, {
      pollOptionId,
      votes: Number(votes),
    });

    return reply.status(201).send();
  });
}
