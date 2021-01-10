import { IGoogleOAuthUserInfoResponse, UserAuthFlow } from "@project-boilerplate/shared";
import { injectable } from "inversify";
import jwt from "jsonwebtoken";

import { TransactionalEmail } from "../../../emails/TransactionalEmail";
import { appEnv } from "../../config/env";
import { BadRequestError } from "../../errors/BadRequestError";
import { ConflictError } from "../../errors/ConflictError";
import { ForbiddenError } from "../../errors/ForbiddenError";
import { InternalServerError } from "../../errors/InternalServerError";
import { NotFoundError } from "../../errors/NotFoundError";
import { UnauthorizedError } from "../../errors/UnauthorizedError";
import { GoogleOAuthHelper } from "../../libs/googleOauth.helper";
import { TS } from "../../libs/translation.helper";
import { IUser, User } from "../user/user.model";
import { AuthLoginDTO, AuthSignUpDTO } from "./auth.dto";
import { AuthRepository } from "./auth.repository";
import { IAuthResponse } from "./auth.types";

@injectable()
export class AuthService {
  constructor(
    private authRepository: AuthRepository,
    private googleOAuthHelper: GoogleOAuthHelper
  ) { }

  /* #############################################################|
    |  >>> BASIC JWT FLOW
    *############################################################## */

  public async signUp(authSignUpDTO: AuthSignUpDTO): Promise<IUser> {
    const { email } = authSignUpDTO;

    // first, check if an user with the same e-mail already exists
    if (await User.checkIfExists(email)) {
      throw new ConflictError(
        TS.translate("users", "userAlreadyExists", { email })
      );
    }

    const newUser = await this.authRepository.signUp(authSignUpDTO);

    if (newUser) {

      console.log("🤖 Submitting new user's welcome e-mail");

      await TransactionalEmail.send(newUser.email, TS.translate("email", "welcome"), "welcome", {
        newAccountEmailTitle: TS.translate("email", "welcome"),
        newAccountEmailFirstParagraph: TS.translate("email", "newAccountEmailFirstParagraph", { appName: appEnv.general.APP_NAME! }),
        newAccountEmailForReference: TS.translate("email", "newAccountEmailForReference"),
        userEmail: newUser.email,
        newAccountEmailBottom: TS.translate("email", "newAccountEmailBottom", { appName: appEnv.general.APP_NAME! })
      });


    }



    return newUser;
  }

  public async login(authLoginDTO: AuthLoginDTO): Promise<IAuthResponse> {
    const { email, password } = authLoginDTO;

    // try to find an user using these credentials
    const user = await User.findByCredentials(email, password);

    if (!user) {
      throw new NotFoundError(TS.translate("auth", "invalidCredentials"));
    }

    // else, if we got an user with these credentials, lets generate an accessToken

    const { accessToken, refreshToken } = await user.generateAccessToken();

    return {
      accessToken,
      refreshToken,
    };
  }

  public async logout(user: IUser, refreshToken: string): Promise<void> {
    //! Remember that JWT tokens are stateless, so there's nothing on server side to remove besides our refresh tokens. Make sure that you wipe out all JWT data from the client. Read more at: https://stackoverflow.com/questions/37959945/how-to-destroy-jwt-tokens-on-logout#:~:text=You%20cannot%20manually%20expire%20a,DB%20query%20on%20every%20request.

    // remove refresh token from Db

    user.refreshTokens = user.refreshTokens?.filter(
      (item) => item.token !== refreshToken
    );

    await user.save();
  }

  /**
   * Generates a new accessToken based on a previous refreshToken
   * @param user
   * @param refreshToken
   */
  public async refreshToken(
    user: IUser,
    refreshToken: string
  ): Promise<string | false> {
    if (!refreshToken) {
      throw new UnauthorizedError(
        TS.translate("auth", "notAllowedResource")
      );
    }

    if (!user.refreshTokens) {
      throw new BadRequestError(TS.translate("auth", "dontHaveRefreshTokens"));
    }
    if (!user.refreshTokens.find((item) => item.token === refreshToken)) {
      throw new BadRequestError(TS.translate("auth", "refreshTokenInvalid"));
    }

    jwt.verify(
      refreshToken,
      appEnv.authentication.REFRESH_TOKEN_SECRET!,
      (err, payload: any) => {
        if (err) {
          throw new ForbiddenError(TS.translate("auth", "refreshTokenInvalid"));
        }

        // provide a new accessToken to the user
        const accessToken = jwt.sign(
          { _id: user._id, email: user.email },
          appEnv.authentication.JWT_SECRET!,
          // { expiresIn: "20m" }
        );

        return accessToken;
      }
    );
    return false;
  }

  /* #############################################################|
  |  >>> GOOGLE OAUTH FLOW
  *############################################################## */

  public async generateGoogleOAuthUrl(): Promise<string> {
    return this.googleOAuthHelper.urlGoogle();
  }

  public async getGoogleUser(
    code: string
  ): Promise<IGoogleOAuthUserInfoResponse> {
    return await this.googleOAuthHelper.getGoogleUser(code);
  }

  /**
   * This function is responsible for handling what happens after we get the userInfo from google (IGoogleOAuthUserInfoResponse), syncing him with our system database
   */
  public async googleOAuthSync(
    googleUserInfo: IGoogleOAuthUserInfoResponse
  ): Promise<IAuthResponse> {
    if (!googleUserInfo.email) {
      throw new InternalServerError(
        TS.translate("auth", "oauthGoogleEmailNotProvided")
      );
    }

    const user = await User.findOne({ email: googleUserInfo.email });

    if (!user) {
      //! create a new user and generate accessToken

      const newUser = await this.authRepository.signUp({
        name: googleUserInfo.name,
        email: googleUserInfo.email,
        authFlow: UserAuthFlow.GoogleOAuth,
      });

      return await newUser.generateAccessToken();
    } else {
      // Check if user already exists on database...
      // just create a new access token and refresh token and provide it

      return await user.generateAccessToken();
    }
  }
}
